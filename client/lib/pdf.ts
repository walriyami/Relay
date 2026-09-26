import type * as PdfJs from "pdfjs-dist";
import type { PDFWorker } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Renders page one of a PDF from byte ranges only, with a strict cumulative byte ceiling.
const CHUNK = 64 * 1024;
const BYTE_BUDGET = 16 * 1024 * 1024;

// One worker serves every thumbnail; starting one per PDF re-parses the worker script each time.
// Cold worker download is network startup, not PDF processing. Over a slow connection it can take
// longer than the bounded read/render allowance, so it gets its own timeout. A worker that fails
// to start is dropped so the next thumbnail tries again.
let shared: Promise<PDFWorker> | null = null;
export function sharedWorker(pdf: typeof PdfJs) {
  shared ??= (async () => {
    pdf.GlobalWorkerOptions.workerSrc = pdfWorker;
    const worker = new pdf.PDFWorker();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        worker.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("PDF worker startup timed out")), 60_000);
        }),
      ]);
      return worker;
    } catch (error) {
      worker.destroy();
      shared = null;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();
  return shared;
}

export async function pdfThumbnail(file: File | undefined, url: string, length: number) {
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error("PDF size unavailable");
  const pdf = await import("pdfjs-dist");
  const worker = await sharedWorker(pdf);
  const controller = new AbortController();
  let used = 0;
  async function read(begin: number, end: number): Promise<Uint8Array> {
    if (controller.signal.aborted || begin < 0 || end > length || end <= begin || (used += end - begin) > BYTE_BUDGET)
      throw new Error("PDF thumbnail byte limit");
    if (file) return new Uint8Array(await file.slice(begin, end).arrayBuffer());
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: { Range: `bytes=${begin}-${end - 1}` },
      signal: controller.signal,
    });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error("Range preview unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Preview unavailable");
    const data = new Uint8Array(end - begin);
    let offset = 0;
    try {
      while (offset < data.length) {
        const part = await reader.read();
        if (part.done) break;
        if (part.value.length > data.length - offset) throw new Error("Unexpected PDF range");
        data.set(part.value, offset);
        offset += part.value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (offset !== data.length) throw new Error("Incomplete PDF range");
    return data;
  }
  let task: ReturnType<typeof pdf.getDocument> | undefined;
  let render:
    | ReturnType<Awaited<ReturnType<Awaited<ReturnType<typeof pdf.getDocument>["promise"]>["getPage"]>>["render"]>
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => {
      controller.abort();
      render?.cancel();
      void task?.destroy();
    }, 15_000);
    const initial = await read(0, Math.min(CHUNK, length));
    class Transport extends pdf.PDFDataRangeTransport {
      requestDataRange(begin: number, end: number) {
        void read(begin, end)
          .then((bytes) => {
            if (!controller.signal.aborted) this.onDataRange(begin, bytes);
          })
          .catch(() => {
            controller.abort();
            void task?.destroy();
          });
      }
      abort() {
        controller.abort();
      }
    }
    const range = new Transport(length, initial, true);
    task = pdf.getDocument({
      worker,
      range,
      rangeChunkSize: CHUNK,
      disableAutoFetch: true,
      disableStream: true,
      useSystemFonts: true,
      maxImageSize: 4_000_000,
      canvasMaxAreaInBytes: 8_000_000,
    });
    const document = await task.promise;
    const page = await document.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: Math.min(1, 480 / Math.max(natural.width, natural.height)),
    });
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    render = page.render({
      canvas,
      canvasContext: context,
      viewport,
      background: "#fff",
    });
    await render.promise;
    const result = canvas.toDataURL("image/webp", 0.8);
    page.cleanup();
    canvas.width = canvas.height = 0;
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Destroying the document leaves the shared worker for the next thumbnail.
    await task?.destroy().catch(() => {});
  }
}
