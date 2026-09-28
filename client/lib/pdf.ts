import type * as PdfJs from "pdfjs-dist";
import type { PDFWorker } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Renders page one of a PDF from byte ranges only, with a strict cumulative byte ceiling.
const CHUNK = 64 * 1024;
const BYTE_BUDGET = 16 * 1024 * 1024;

// One explicitly owned native worker serves every thumbnail. pdf.js only owns its internally
// created Worker after the handshake, and supplying a port resolves PDFWorker.promise before
// initialization. Wait for the real worker's ready message before starting document deadlines.
type ThumbnailWorker = {
  ready: Promise<PDFWorker>;
  failed: Error | null;
  listeners: Set<(error: Error) => void>;
  stop: (error: Error) => void;
};
let shared: ThumbnailWorker | null = null;
function sharedWorker(pdf: typeof PdfJs): ThumbnailWorker {
  if (shared) return shared;
  let nativeWorker: Worker | undefined;
  let worker: PDFWorker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (worker: PDFWorker) => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<PDFWorker>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  const entry: ThumbnailWorker = {
    ready,
    failed: null,
    listeners: new Set(),
    stop(error) {
      if (entry.failed) return;
      entry.failed = error;
      if (shared === entry) shared = null;
      clearTimeout(timer);
      nativeWorker?.removeEventListener("message", initialized);
      nativeWorker?.removeEventListener("error", failed);
      nativeWorker?.removeEventListener("messageerror", failed);
      worker?.destroy();
      nativeWorker?.terminate();
      reject(error);
      for (const listener of entry.listeners) listener(error);
      entry.listeners.clear();
    },
  };
  function failed() {
    entry.stop(new Error("PDF worker failed"));
  }
  function initialized(event: MessageEvent<{ sourceName?: string; targetName?: string; action?: string }>) {
    const message = event.data;
    if (message?.sourceName !== "worker" || message.targetName !== "main" || message.action !== "ready") return;
    nativeWorker!.removeEventListener("message", initialized);
    clearTimeout(timer);
    try {
      worker = pdf.PDFWorker.create({ port: nativeWorker! });
      resolve(worker);
    } catch {
      failed();
    }
  }
  shared = entry;
  try {
    nativeWorker = new Worker(pdfWorker, { type: "module" });
    nativeWorker.addEventListener("message", initialized);
    nativeWorker.addEventListener("error", failed);
    nativeWorker.addEventListener("messageerror", failed);
    timer = setTimeout(() => entry.stop(new Error("PDF worker startup timed out")), 60_000);
  } catch {
    failed();
  }
  return entry;
}

export async function pdfThumbnail(file: File | undefined, url: string, length: number) {
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error("PDF size unavailable");
  const pdf = await import("pdfjs-dist");
  const shared = sharedWorker(pdf);
  const worker = await shared.ready;
  const controller = new AbortController();
  let used = 0;
  async function read(begin: number, end: number): Promise<Uint8Array> {
    controller.signal.throwIfAborted();
    if (begin < 0 || end > length || end <= begin || (used += end - begin) > BYTE_BUDGET)
      throw new Error("PDF thumbnail byte limit");
    if (file) {
      const data = new Uint8Array(await file.slice(begin, end).arrayBuffer());
      controller.signal.throwIfAborted();
      return data;
    }
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
  let canvas: HTMLCanvasElement | undefined;
  let reject!: (error: Error) => void;
  const cancelled = new Promise<never>((_, fail) => {
    reject = fail;
  });
  const fail = (error: Error) => {
    if (controller.signal.aborted) return;
    controller.abort(error);
    render?.cancel();
    reject(error);
  };
  shared.listeners.add(fail);
  if (shared.failed) fail(shared.failed);
  const timer = setTimeout(() => fail(new Error("PDF thumbnail timed out")), 15_000);
  async function draw() {
    const initial = await read(0, Math.min(CHUNK, length));
    controller.signal.throwIfAborted();
    class Transport extends pdf.PDFDataRangeTransport {
      requestDataRange(begin: number, end: number) {
        void read(begin, end)
          .then((bytes) => {
            if (!controller.signal.aborted) this.onDataRange(begin, bytes);
          })
          .catch((error: Error) => fail(error));
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
    controller.signal.throwIfAborted();
    const page = await document.getPage(1);
    try {
      controller.signal.throwIfAborted();
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(1, 480 / Math.max(natural.width, natural.height)),
      });
      canvas = window.document.createElement("canvas");
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
      controller.signal.throwIfAborted();
      return canvas.toDataURL("image/webp", 0.8);
    } finally {
      page.cleanup();
      if (canvas) canvas.width = canvas.height = 0;
    }
  }
  try {
    return await Promise.race([draw(), cancelled]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    shared.listeners.delete(fail);
    render?.cancel();
    // Healthy documents release their resources without interrupting concurrent thumbnails.
    // A missing setup/termination reply can leave pdf.js destroy pending forever: bound it,
    // recycle that worker, and reject any remaining thumbnails using the same failed port.
    let shutdown: ReturnType<typeof setTimeout> | undefined;
    if (task) {
      try {
        await Promise.race([
          task.destroy().catch(() => shared.stop(new Error("PDF worker cleanup failed"))),
          new Promise<void>((resolve) => {
            shutdown = setTimeout(() => {
              shared.stop(new Error("PDF worker cleanup timed out"));
              resolve();
            }, 1000);
          }),
        ]);
      } finally {
        clearTimeout(shutdown);
      }
    }
    if (canvas) canvas.width = canvas.height = 0;
  }
}
