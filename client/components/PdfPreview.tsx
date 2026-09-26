import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { plural } from "../lib/format";
import { sharedWorker } from "../lib/pdf";
import { Spinner } from "./ui";

// Pages are drawn with pdf.js because many browsers (Android Chrome, iOS Safari) cannot show a PDF
// inside a frame. The file is read in ranges, and each page is drawn only when it scrolls near view.
const PAGE_LIMIT = 300;

export function PdfPreview({ url, name, onFailed }: { url: string; name: string; onFailed: () => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [ratio, setRatio] = useState(1.294);
  const failed = useRef(onFailed);
  failed.current = onFailed;
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    (async () => {
      const pdf = await import("pdfjs-dist");
      const worker = await sharedWorker(pdf);
      if (cancelled) return;
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
      const loaded = await task.promise;
      const first = (await loaded.getPage(1)).getViewport({ scale: 1 });
      if (cancelled) return;
      setRatio(first.height / first.width);
      setDoc(loaded);
    })().catch(() => {
      if (!cancelled) failed.current();
    });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url]);
  if (!doc)
    return (
      <div className="preview-pdf preview-pdf-loading">
        <Spinner label="Loading PDF" />
      </div>
    );
  const pages = Math.min(doc.numPages, PAGE_LIMIT);
  return (
    <div className="preview-pdf" role="document" aria-label={`${name}, ${plural(doc.numPages, "page")}`} tabIndex={0}>
      {Array.from({ length: pages }, (_, i) => (
        <PdfPage key={i} doc={doc} number={i + 1} ratio={ratio} />
      ))}
      {doc.numPages > pages && (
        <p className="muted preview-pdf-more">
          Showing the first {pages} of {doc.numPages} pages. Download the file to read the rest.
        </p>
      )}
    </div>
  );
}

function PdfPage({ doc, number, ratio }: { doc: PDFDocumentProxy; number: number; ratio: number }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [aspect, setAspect] = useState(ratio);
  const [error, setError] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setNear(true), {
      rootMargin: "800px 0px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!near) return;
    let render: ReturnType<PDFPageProxy["render"]> | undefined;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(number);
      const el = canvas.current;
      if (cancelled || !el || !box.current) return;
      const natural = page.getViewport({ scale: 1 });
      setAspect(natural.height / natural.width);
      const scale = (box.current.clientWidth * Math.min(window.devicePixelRatio || 1, 2)) / natural.width;
      const viewport = page.getViewport({ scale });
      el.width = Math.max(1, Math.floor(viewport.width));
      el.height = Math.max(1, Math.floor(viewport.height));
      const context = el.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      render = page.render({ canvas: el, canvasContext: context, viewport, background: "#fff" });
      await render.promise;
    })().catch((e: Error) => {
      if (!cancelled && e?.name !== "RenderingCancelledException") setError(true);
    });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [near, doc, number]);
  return (
    <div ref={box} className="preview-pdf-page" style={{ aspectRatio: `1 / ${aspect}` }}>
      {error ? (
        <span className="muted">Page {number} couldn’t be shown.</span>
      ) : (
        <canvas ref={canvas} aria-label={`Page ${number}`} role="img" />
      )}
    </div>
  );
}
