import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFWorker } from "pdfjs-dist";
import type { PDFSinglePageViewer, PDFPageView, PDFFindController, EventBus } from "pdfjs-dist/web/pdf_viewer.mjs";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import "../styles/pdf-reader.css";
import { Button, IconButton, Spinner } from "./ui";

type Reader = { viewer: PDFSinglePageViewer; find: PDFFindController; events: EventBus };

/** PDF.js owns page layout, selectable text, document structure, rendering and search. */
export function PdfReader({ url, name }: { url: string; name: string }) {
  const [attempt, setAttempt] = useState(0);
  return <ReaderDocument key={`${url}:${attempt}`} url={url} name={name} retry={() => setAttempt(attempt + 1)} />;
}

function ReaderDocument({ url, name, retry }: { url: string; name: string; retry: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const reader = useRef<Reader | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("Loading PDF");
  const [error, setError] = useState("");
  const [count, setCount] = useState(0);
  const [number, setNumber] = useState("1");
  const [scale, setScale] = useState(100);
  const [fit, setFit] = useState("page-width");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState("");

  useEffect(() => {
    let disposed = false;
    let ready = false;
    let task: PDFDocumentLoadingTask | undefined;
    let worker: PDFWorker | undefined;
    let native: Worker | undefined;
    let viewer: PDFSinglePageViewer | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let shutdown: ReturnType<typeof setTimeout> | undefined;
    const eventsLifetime = new AbortController();
    const stop = () => {
      clearTimeout(shutdown);
      worker?.destroy();
      native?.terminate();
      native = undefined;
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(deadline);
      eventsLifetime.abort();
      reader.current = null;
      // setDocument(null) drops its cache; explicitly destroy the public page views
      // first so detached canvases release backing storage without waiting for GC.
      if (viewer)
        for (let i = 0; i < viewer.pagesCount; i++) (viewer.getPageView(i) as PDFPageView | undefined)?.destroy();
      // PDF.js implements null teardown, but its published declaration omits null.
      // @ts-expect-error -- See PDFViewer.setDocument null branch in pdfjs-dist 6.3.289.
      viewer?.setDocument(null);
      native?.removeEventListener("error", fail);
      native?.removeEventListener("messageerror", fail);
      // A stalled handshake cannot be awaited. A ready worker gets time to release its document.
      if (ready) shutdown = setTimeout(stop, 1000);
      else stop();
      void Promise.resolve()
        .then(() => task?.destroy())
        .catch(() => {})
        .finally(stop);
    };
    const fail = () => {
      if (disposed) return;
      setError("This PDF couldn’t be loaded. Try again or download it.");
      setStatus("");
      dispose();
    };
    (async () => {
      const pdf = await import("pdfjs-dist");
      if (disposed) return;
      // The component build reads pdfjsLib initialized by the matching core module.
      const components = await import("pdfjs-dist/web/pdf_viewer.mjs");
      if (disposed || !container.current || !pages.current) return;
      const events = new components.EventBus();
      const links = new components.PDFLinkService({ eventBus: events });
      const find = new components.PDFFindController({ eventBus: events, linkService: links });
      // abortSignal is supported by PDF.js for its observers and listeners;
      // the 6.3.289 declaration has not included it yet.
      const options: ConstructorParameters<typeof components.PDFSinglePageViewer>[0] & { abortSignal: AbortSignal } = {
        abortSignal: eventsLifetime.signal,
        container: container.current,
        viewer: pages.current,
        eventBus: events,
        linkService: links,
        findController: find,
        // One visible page plus PDF.js's bounded ten-view cache. No secondary detail canvas.
        maxCanvasPixels: 2_000_000,
        maxCanvasDim: 8192,
        enableDetailCanvas: false,
        annotationMode: pdf.AnnotationMode.DISABLE,
        annotationEditorMode: pdf.AnnotationEditorType.DISABLE,
        enableAutoLinking: false,
      };
      viewer = new components.PDFSinglePageViewer(options);
      let resizing = 0;
      const resize = new ResizeObserver(() => {
        cancelAnimationFrame(resizing);
        resizing = requestAnimationFrame(() => {
          const fitted = viewer?.currentScaleValue;
          if (!disposed && fitted?.startsWith("page-") && viewer) viewer.currentScaleValue = fitted;
        });
      });
      resize.observe(container.current);
      eventsLifetime.signal.addEventListener(
        "abort",
        () => {
          resize.disconnect();
          cancelAnimationFrame(resizing);
        },
        { once: true },
      );
      links.setViewer(viewer);
      reader.current = { viewer, find, events };
      const signal = eventsLifetime.signal;
      events.on(
        "pagesinit",
        () => {
          if (disposed || !viewer) return;
          setCount(viewer.pagesCount);
          viewer.currentScaleValue = "page-width";
        },
        { signal },
      );
      events.on(
        "pagechanging",
        ({ pageNumber }: { pageNumber: number }) => {
          if (disposed) return;
          setNumber(String(pageNumber));
          const cached =
            (viewer?.getPageView(pageNumber - 1) as PDFPageView | undefined)?.renderingState ===
            components.RenderingStates.FINISHED;
          setStatus(cached ? "" : `Loading page ${pageNumber}`);
          clearTimeout(deadline);
          if (!cached) deadline = setTimeout(fail, 60_000);
        },
        { signal },
      );
      events.on(
        "scalechanging",
        ({ scale }: { scale: number }) => {
          if (!disposed) setScale(Math.round(scale * 100));
        },
        { signal },
      );
      events.on(
        "pagerendered",
        ({ error, pageNumber }: { error?: Error; pageNumber: number }) => {
          if (disposed || pageNumber !== viewer?.currentPageNumber) return;
          if (error) fail();
          else {
            clearTimeout(deadline);
            setStatus("");
          }
        },
        { signal },
      );
      events.on(
        "updatefindmatchescount",
        ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
          if (!disposed) setMatches(`${matchesCount.current} of ${matchesCount.total} matches`);
        },
        { signal },
      );
      events.on(
        "updatefindcontrolstate",
        ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) => {
          if (disposed) return;
          if (state === components.FindState.PENDING) setMatches("Searching PDF…");
          else if (state === components.FindState.NOT_FOUND) setMatches("No matches");
          else setMatches(`${matchesCount.current} of ${matchesCount.total} matches`);
        },
        { signal },
      );
      native = new Worker(pdfWorker, { type: "module" });
      native.addEventListener("error", fail);
      native.addEventListener("messageerror", fail);
      worker = pdf.PDFWorker.create({ port: native });
      deadline = setTimeout(fail, 60_000);
      task = pdf.getDocument({
        url,
        worker,
        withCredentials: true,
        rangeChunkSize: 256 * 1024,
        disableAutoFetch: true,
        disableStream: true,
        useWasm: false,
        useSystemFonts: true,
        canvasMaxAreaInBytes: 32_000_000,
      });
      task.onPassword = () => {
        if (disposed) return;
        setError("This PDF needs a password. Download it to open it with your PDF reader.");
        setStatus("");
        dispose();
      };
      const document = await task.promise;
      if (disposed) return;
      ready = true;
      links.setDocument(document);
      viewer.setDocument(document);
    })().catch(fail);
    return dispose;
  }, [url]);

  function go(value: number) {
    const viewer = reader.current?.viewer;
    if (!viewer || !count) return;
    viewer.currentPageNumber = Math.max(1, Math.min(count, Math.trunc(value) || 1));
    setNumber(String(viewer.currentPageNumber));
  }
  function find(value: string, again = false, previous = false) {
    if (!value) {
      reader.current?.events.dispatch("findbarclose", {});
      setMatches("");
      return;
    }
    reader.current?.events.dispatch("find", {
      query: value,
      type: again ? "again" : "",
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  }
  return (
    <div
      className="pdf-reader"
      onKeyDown={(event) => {
        // Document arrows belong to the reader, rather than switching the file underneath it.
        if (event.key.startsWith("Arrow")) event.stopPropagation();
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          search.current?.focus();
        }
      }}
    >
      <div className="pdf-reader-controls" role="group" aria-label="PDF reading controls">
        <IconButton
          label="Previous page"
          icon={<ChevronLeft size={16} />}
          disabled={!count || !!error || Number(number) <= 1}
          onClick={() => go(Number(number) - 1)}
        />
        <label className="pdf-reader-page">
          Page{" "}
          <input
            aria-label="PDF page"
            type="number"
            min={1}
            max={count || 1}
            value={number}
            disabled={!count || !!error}
            onChange={(event) => setNumber(event.target.value)}
            onBlur={() => go(Number(number))}
            onKeyDown={(event) => {
              if (event.key === "Enter") go(Number(number));
            }}
          />{" "}
          <span>of {count || "…"}</span>
        </label>
        <IconButton
          label="Next page"
          icon={<ChevronRight size={16} />}
          disabled={!count || !!error || Number(number) >= count}
          onClick={() => go(Number(number) + 1)}
        />
        <IconButton
          label="Zoom out"
          icon={<ZoomOut size={16} />}
          disabled={!count || !!error || scale <= 25}
          onClick={() => {
            const viewer = reader.current?.viewer;
            if (viewer) viewer.currentScale = Math.max(0.25, viewer.currentScale / 1.25);
            setFit("");
          }}
        />
        <output aria-label="PDF zoom">{scale}%</output>
        <IconButton
          label="Zoom in"
          icon={<ZoomIn size={16} />}
          disabled={!count || !!error || scale >= 400}
          onClick={() => {
            const viewer = reader.current?.viewer;
            if (viewer) viewer.currentScale = Math.min(4, viewer.currentScale * 1.25);
            setFit("");
          }}
        />
        <select
          aria-label="Fit PDF"
          value={fit}
          disabled={!count || !!error}
          onChange={(event) => {
            setFit(event.target.value);
            if (reader.current) reader.current.viewer.currentScaleValue = event.target.value;
          }}
        >
          <option value="" disabled>
            Custom zoom
          </option>
          <option value="page-width">Fit width</option>
          <option value="page-fit">Fit page</option>
        </select>
      </div>
      <div className="pdf-reader-search" role="search" aria-label="Search PDF">
        <input
          ref={search}
          type="search"
          aria-label="Find in PDF"
          placeholder="Find in PDF"
          value={query}
          disabled={!count || !!error}
          onChange={(event) => {
            setQuery(event.target.value);
            find(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              find(query, true, event.shiftKey);
            }
          }}
        />
        <IconButton
          label="Previous match"
          icon={<ChevronLeft size={16} />}
          disabled={!query || !!error}
          onClick={() => find(query, true, true)}
        />
        <IconButton
          label="Next match"
          icon={<ChevronRight size={16} />}
          disabled={!query || !!error}
          onClick={() => find(query, true)}
        />
        <span role="status" className="muted">
          {matches}
        </span>
      </div>
      <div className="pdf-reader-stage">
        <div
          ref={container}
          className="pdf-reader-scroll"
          role="document"
          aria-label={`${name}${count ? `, ${count} pages` : ""}`}
          tabIndex={0}
        >
          <div ref={pages} className="pdfViewer" />
        </div>
        {status && !error && (
          <div className="pdf-reader-loading">
            <Spinner label={status} />
          </div>
        )}
        {error && (
          <div className="pdf-reader-error">
            <p role="alert">{error}</p>
            <Button onClick={retry}>Try again</Button>
          </div>
        )}
      </div>
    </div>
  );
}
