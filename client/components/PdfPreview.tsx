import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, PDFWorker } from "pdfjs-dist";
import { plural } from "../lib/format";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Spinner } from "./ui";

const PAGE_LIMIT = 300;
const RETAINED_PAGES = 6;
const PAGE_PIXELS = 2_000_000;
const TOTAL_PIXELS = RETAINED_PAGES * PAGE_PIXELS;
const RENDER_CONCURRENCY = 2;
const CANVAS_SIDE = 8192;

// The queue includes page loading and waits for cancelled renders to settle before reusing their
// slot (or page). Offscreen jobs never start. At most two PDF pages are being prepared at once.
class RenderQueue {
  private jobs: { page: number; controller: AbortController; run: (signal: AbortSignal) => Promise<void> }[] = [];
  private running = new Set<number>();

  add(page: number, run: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    const job = { page, controller, run };
    this.jobs.push(job);
    this.drain();
    return () => {
      controller.abort();
      this.jobs = this.jobs.filter((queued) => queued !== job);
    };
  }

  private drain() {
    while (this.running.size < RENDER_CONCURRENCY) {
      const index = this.jobs.findIndex((job) => !this.running.has(job.page));
      if (index < 0) return;
      const [job] = this.jobs.splice(index, 1);
      this.running.add(job.page);
      void job
        .run(job.controller.signal)
        .catch(() => {})
        .finally(() => {
          this.running.delete(job.page);
          this.drain();
        });
    }
  }
}

export function PdfPreview(props: { url: string; name: string; onFailed: () => void }) {
  // Changing files discards the old document, measured page sizes, render queue and observers.
  return <PdfDocument key={props.url} {...props} />;
}

function PdfDocument({ url, name, onFailed }: { url: string; name: string; onFailed: () => void }) {
  const [loaded, setLoaded] = useState<{ doc: PDFDocumentProxy; ratio: number } | null>(null);
  const failed = useRef(onFailed);
  failed.current = onFailed;
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    let worker: PDFWorker | undefined;
    let nativeWorker: Worker | undefined;
    let startup: ReturnType<typeof setTimeout> | undefined;
    let shutdown: ReturnType<typeof setTimeout> | undefined;
    let documentReady = false;
    let disposed = false;
    let stopped = false;
    const stopWorker = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(shutdown);
      worker?.destroy();
      nativeWorker?.terminate();
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(startup);
      nativeWorker?.removeEventListener("error", fail);
      nativeWorker?.removeEventListener("messageerror", fail);
      // A ready document gets a bounded chance to release fonts, requests and page resources.
      // During startup, pdf.js destroy can wait forever for a missing worker handshake.
      if (documentReady) shutdown = setTimeout(stopWorker, 1000);
      else stopWorker();
      void Promise.resolve()
        .then(() => task?.destroy())
        .catch(() => {})
        .finally(stopWorker);
    };
    const fail = () => {
      if (disposed) return;
      dispose();
      if (!cancelled) failed.current();
    };
    (async () => {
      const pdf = await import("pdfjs-dist");
      if (cancelled) return;
      // Own the native port from construction; PDFWorker only owns its internal Worker after
      // a successful handshake. This port is independent of the shared thumbnail worker.
      nativeWorker = new Worker(pdfWorker, { type: "module" });
      nativeWorker.addEventListener("error", fail);
      nativeWorker.addEventListener("messageerror", fail);
      worker = pdf.PDFWorker.create({ port: nativeWorker });
      // Supplying a port resolves worker.promise immediately, so include document and first
      // page loading in the deadline rather than relying on that promise as a handshake.
      startup = setTimeout(fail, 60_000);
      await worker.promise;
      if (disposed) return;
      task = pdf.getDocument({
        url,
        worker,
        withCredentials: true,
        rangeChunkSize: 256 * 1024,
        disableAutoFetch: true,
        disableStream: true,
        useSystemFonts: true,
        canvasMaxAreaInBytes: 32_000_000,
      });
      const doc = await task.promise;
      if (disposed) return;
      documentReady = true;
      const page = await doc.getPage(1);
      try {
        if (disposed) return;
        const first = page.getViewport({ scale: 1 });
        clearTimeout(startup);
        setLoaded({ doc, ratio: first.height / first.width });
      } finally {
        page.cleanup();
      }
    })().catch(fail);
    return () => {
      cancelled = true;
      dispose();
    };
  }, [url]);
  if (!loaded)
    return (
      <div className="preview-pdf preview-pdf-loading">
        <Spinner label="Loading PDF" />
      </div>
    );
  return <PdfPages {...loaded} name={name} />;
}

function PdfPages({ doc, ratio, name }: { doc: PDFDocumentProxy; ratio: number; name: string }) {
  const root = useRef<HTMLDivElement>(null);
  const queue = useMemo(() => new RenderQueue(), []);
  const [window, setWindow] = useState<number[]>([]);
  const [resolution, setResolution] = useState({ width: 0, dpr: 1 });
  const pages = Math.min(doc.numPages, PAGE_LIMIT);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const boxes = Array.from(el.querySelectorAll<HTMLElement>(".preview-pdf-page"));
    const nearby = new Set<HTMLElement>();
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = el.getBoundingClientRect();
      const center = (rect.top + rect.bottom) / 2;
      const candidates = [...nearby]
        .map((box) => {
          const bounds = box.getBoundingClientRect();
          // Prefer pages actually visible, then the nearest overscan pages.
          const visible = bounds.bottom > rect.top && bounds.top < rect.bottom;
          return {
            number: Number(box.dataset.page),
            distance: Math.abs((bounds.top + bounds.bottom) / 2 - center),
            visible,
          };
        })
        .sort((a, b) => Number(b.visible) - Number(a.visible) || a.distance - b.distance);
      // Short pages can put more than six pages onscreen. Keep all visible pages and divide
      // the fixed pixel budget between them, using overscan only when fewer are visible.
      const next = candidates
        .slice(0, Math.max(RETAINED_PAGES, candidates.filter((box) => box.visible).length))
        .map((box) => box.number)
        .sort((a, b) => a - b);
      setWindow((previous) => (previous.join() === next.join() ? previous : next));
      const width = boxes[0]?.clientWidth ?? 0;
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      setResolution((previous) => (previous.width === width && previous.dpr === dpr ? previous : { width, dpr }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) nearby.add(entry.target as HTMLElement);
          else nearby.delete(entry.target as HTMLElement);
        }
        schedule();
      },
      { root: el, rootMargin: "800px 0px" },
    );
    boxes.forEach((box) => observer.observe(box));
    const resize = new ResizeObserver(schedule);
    resize.observe(el);
    boxes.forEach((box) => resize.observe(box));
    el.addEventListener("scroll", schedule, { passive: true });
    globalThis.addEventListener("resize", schedule);
    let density = matchMedia(`(resolution: ${globalThis.devicePixelRatio}dppx)`);
    const changedDensity = () => {
      density.removeEventListener("change", changedDensity);
      density = matchMedia(`(resolution: ${globalThis.devicePixelRatio}dppx)`);
      density.addEventListener("change", changedDensity);
      schedule();
    };
    density.addEventListener("change", changedDensity);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      el.removeEventListener("scroll", schedule);
      globalThis.removeEventListener("resize", schedule);
      density.removeEventListener("change", changedDensity);
    };
  }, []);
  return (
    <div
      ref={root}
      className="preview-pdf"
      role="document"
      aria-label={`${name}, ${plural(doc.numPages, "page")}`}
      tabIndex={0}
    >
      {Array.from({ length: pages }, (_, i) => (
        <PdfPage
          key={i}
          doc={doc}
          number={i + 1}
          ratio={ratio}
          queue={queue}
          active={window.includes(i + 1)}
          pixelLimit={Math.min(PAGE_PIXELS, Math.floor(TOTAL_PIXELS / Math.max(window.length, 1)))}
          {...resolution}
        />
      ))}
      {doc.numPages > pages && (
        <p className="muted preview-pdf-more">
          Showing the first {pages} of {doc.numPages} pages. Download the file to read the rest.
        </p>
      )}
    </div>
  );
}

function PdfPage({
  doc,
  number,
  ratio,
  queue,
  active,
  width,
  dpr,
  pixelLimit,
}: {
  doc: PDFDocumentProxy;
  number: number;
  ratio: number;
  queue: RenderQueue;
  active: boolean;
  width: number;
  dpr: number;
  pixelLimit: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState(ratio);
  const [status, setStatus] = useState("waiting");
  useEffect(() => {
    const el = canvas.current;
    if (!active || !width || !el) return;
    setStatus("loading");
    const clear = () => {
      el.width = el.height = 0;
    };
    const cancel = queue.add(number, async (signal) => {
      let page: PDFPageProxy | undefined;
      let render: ReturnType<PDFPageProxy["render"]> | undefined;
      const abort = () => {
        render?.cancel();
        clear();
      };
      signal.addEventListener("abort", abort);
      try {
        page = await doc.getPage(number);
        if (signal.aborted) return;
        const natural = page.getViewport({ scale: 1 });
        setAspect(natural.height / natural.width);
        // The active pages share <= twelve million pixels (48 MB of RGBA backing), with
        // <= two million per page, regardless of visible page count or page proportions.
        const scale = Math.min(
          (width * dpr) / natural.width,
          Math.sqrt(pixelLimit / (natural.width * natural.height)),
          CANVAS_SIDE / natural.width,
          CANVAS_SIDE / natural.height,
        );
        const viewport = page.getViewport({ scale });
        el.width = Math.max(1, Math.floor(viewport.width));
        el.height = Math.max(1, Math.min(Math.floor(viewport.height), Math.floor(pixelLimit / el.width)));
        const context = el.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        render = page.render({ canvas: el, canvasContext: context, viewport, background: "#fff" });
        await render.promise;
        if (!signal.aborted) setStatus("ready");
      } catch {
        if (!signal.aborted) {
          clear();
          setStatus("error");
        }
      } finally {
        signal.removeEventListener("abort", abort);
        page?.cleanup();
      }
    });
    return () => {
      cancel();
      clear();
    };
  }, [active, doc, number, queue, width, dpr, pixelLimit]);
  return (
    <div className="preview-pdf-page" data-page={number} style={{ aspectRatio: `1 / ${aspect}` }}>
      <canvas
        ref={canvas}
        width={0}
        height={0}
        aria-label={`Page ${number}`}
        role="img"
        data-rendered={active && status === "ready"}
        hidden={status === "error"}
      />
      {status === "error" && <span className="muted">Page {number} couldn’t be shown.</span>}
    </div>
  );
}
