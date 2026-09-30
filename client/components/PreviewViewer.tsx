import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, ZoomIn, ZoomOut } from "lucide-react";
import type { NodeRef } from "../api";
import { download } from "../lib/download";
import { bytes, kindLabel, previewKind } from "../lib/format";
import type { ContentSource } from "../lib/source";
import { FileTypeIcon } from "./Thumbnail";
import { Button, CopyButton, IconButton, Modal, Spinner } from "./ui";

const PdfReader = lazy(() => import("./PdfReader").then((module) => ({ default: module.PdfReader })));

const TEXT_LIMIT = 1024 * 1024;
const ORIGINAL_IMAGE_LIMIT = 20 * 1024 ** 2;

function TextPreview({ url, size }: { url: string; size: number }) {
  const [state, setState] = useState<{ text?: string; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    fetch(url, {
      headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` },
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("This file could not be loaded.");
        const reader = response.body!.getReader();
        const parts: Uint8Array[] = [];
        let total = 0;
        while (total < TEXT_LIMIT) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          total += value.length;
        }
        void reader.cancel().catch(() => {});
        const all = new Uint8Array(Math.min(total, TEXT_LIMIT));
        let offset = 0;
        for (const part of parts) {
          const slice = part.subarray(0, all.length - offset);
          all.set(slice, offset);
          offset += slice.length;
          if (offset >= all.length) break;
        }
        setState({ text: new TextDecoder().decode(all) });
      })
      .catch((error: Error) => {
        if (error.name !== "AbortError") setState({ error: error.message });
      });
    return () => controller.abort();
  }, [url]);
  if (state.error) return <p className="muted">{state.error}</p>;
  if (state.text === undefined) return <Spinner label="Loading text" />;
  return (
    <div className="preview-text">
      <div className="row between">
        {/* The size is already in the header; it is repeated only to say the text was cut short. */}
        <span className="muted">{size > TEXT_LIMIT ? `Showing the first 1 MB of ${bytes(size)}` : ""}</span>
        <CopyButton value={state.text} size="sm" />
      </div>
      <pre tabIndex={0}>{state.text}</pre>
    </div>
  );
}

/** Formats every browser shows natively; anything else (HEIC, TIFF, RAW) is shown as the server's render. */
const NATIVE_IMAGE = /^image\/(jpeg|png|gif|webp|avif|bmp)$/;
const NATIVE_EXTENSION = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
/** Pointer travel that turns a click into a pan. */
const DRAG_SLOP = 4;

/**
 * An image fitted to the space it has. Clicking it (or the zoom button) shows it at full size,
 * from the original file when the browser can show that, scrolled so the clicked spot stays under
 * the pointer; dragging pans. The large render is shown first because it loads much sooner.
 */
function ImagePreview({ entry, source }: { entry: NodeRef; source: ContentSource }) {
  const original = source.file(entry.id, true);
  const native =
    entry.size <= ORIGINAL_IMAGE_LIMIT && (NATIVE_IMAGE.test(entry.mime) || NATIVE_EXTENSION.test(entry.path));
  const animated = /\.gif$/i.test(entry.path) || entry.mime === "image/gif";
  const [src, setSrc] = useState(animated && native ? original : source.thumb(entry.id, "l"));
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [fits, setFits] = useState(true);
  const frame = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  /** Where to keep in view when zooming: the spot as a fraction of the image, and of the frame. */
  const anchor = useRef({ x: 0.5, y: 0.5, px: 0.5, py: 0.5 });
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);

  // Whether full size would show more than the fitted image does.
  const measure = () => {
    const img = image.current;
    if (img && !zoomed) setFits(img.naturalWidth <= img.clientWidth + 1 && img.naturalHeight <= img.clientHeight + 1);
  };
  useEffect(() => {
    const img = image.current;
    if (!img || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(img);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `measure` only reads `zoomed`.
  }, [zoomed]);
  useLayoutEffect(() => {
    const box = frame.current;
    const img = image.current;
    if (!zoomed || !box || !img) return;
    const { x, y, px, py } = anchor.current;
    box.scrollLeft = x * img.offsetWidth - px * box.clientWidth;
    box.scrollTop = y * img.offsetHeight - py * box.clientHeight;
  }, [zoomed, src, loaded]);

  const zoomable = zoomed || !fits || (native && src !== original);
  function toggle(at?: { clientX: number; clientY: number }) {
    const box = frame.current?.getBoundingClientRect();
    const img = image.current?.getBoundingClientRect();
    if (!zoomed && box && img && at) {
      const clamp = (v: number) => Math.min(1, Math.max(0, v));
      anchor.current = {
        x: clamp((at.clientX - img.left) / img.width),
        y: clamp((at.clientY - img.top) / img.height),
        px: (at.clientX - box.left) / box.width,
        py: (at.clientY - box.top) / box.height,
      };
    } else anchor.current = { x: 0.5, y: 0.5, px: 0.5, py: 0.5 };
    if (!zoomed && native && src !== original) {
      setLoaded(false);
      setSrc(original);
    }
    setZoomed(!zoomed);
  }

  if (failed) return <NoPreview entry={entry} message="This image format can’t be previewed in the browser." />;
  return (
    <div className={`preview-image${zoomed ? " is-zoomed" : ""}${zoomable ? " is-zoomable" : ""}`}>
      <div
        ref={frame}
        className="preview-image-frame"
        onPointerDown={(event) => {
          // Touch and pens scroll the frame natively.
          if (!zoomed || event.button !== 0 || event.pointerType !== "mouse") return;
          const box = frame.current!;
          drag.current = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop, moved: false };
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d) return;
          const dx = event.clientX - d.x;
          const dy = event.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
          if (!d.moved) frame.current!.setPointerCapture(event.pointerId);
          d.moved = true;
          frame.current!.scrollLeft = d.left - dx;
          frame.current!.scrollTop = d.top - dy;
        }}
        onPointerCancel={() => (drag.current = null)}
        onPointerUp={() => {
          // A pan ends here; the click that follows it must not zoom out.
          setTimeout(() => (drag.current = null));
        }}
        onClick={(event) => {
          if (drag.current?.moved || !zoomable) return;
          toggle(event);
        }}
      >
        {!loaded && <Spinner label="Loading image" />}
        <img
          ref={image}
          src={src}
          alt={entry.name}
          draggable={false}
          onLoad={() => {
            setLoaded(true);
            measure();
          }}
          onError={() => {
            if (src !== original && native) setSrc(original);
            else setFailed(true);
          }}
          style={loaded ? undefined : { opacity: 0 }}
        />
      </div>
      {zoomable && (
        <IconButton
          className="preview-zoom"
          variant="secondary"
          size="sm"
          label={zoomed ? "Fit to window" : "Show at full size"}
          aria-pressed={zoomed}
          icon={zoomed ? <ZoomOut size={16} /> : <ZoomIn size={16} />}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        />
      )}
    </div>
  );
}

function NoPreview({ entry, message }: { entry: NodeRef; message?: string }) {
  return (
    <div className="preview-none">
      <FileTypeIcon path={entry.path} mime={entry.mime} size={48} />
      <strong>{entry.name}</strong>
      <span className="muted">
        {kindLabel(entry.path)} · {bytes(entry.size)}
      </span>
      <span className="muted">{message || "There’s no preview for this type of file."}</span>
    </div>
  );
}

/** Full, bounded file preview shared by the viewer and a single-file library item. */
export function FilePreview({ entry, source }: { entry: NodeRef; source: ContentSource }) {
  const kind = previewKind(entry.path, entry.mime);
  const inline = source.file(entry.id, true);
  if (kind === "image") return <ImagePreview entry={entry} source={source} />;
  if (kind === "pdf")
    return (
      <Suspense fallback={<Spinner label="Loading PDF" />}>
        <PdfReader url={inline} name={entry.name} />
      </Suspense>
    );
  if (entry.size === 0) return <NoPreview entry={entry} message="This file is empty." />;
  if (kind === "text") return <TextPreview url={source.file(entry.id)} size={entry.size} />;
  if (kind === "video") return <video className="preview-media" src={inline} controls playsInline preload="metadata" />;
  if (kind === "audio")
    return (
      <div className="preview-none">
        <FileTypeIcon path={entry.path} mime={entry.mime} size={48} />
        <strong>{entry.name}</strong>
        <audio src={inline} controls preload="metadata" />
      </div>
    );
  return <NoPreview entry={entry} />;
}

export function PreviewViewer({
  entries,
  start,
  source,
  onClose,
}: {
  entries: NodeRef[];
  start: number;
  source: ContentSource;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(start);
  const entry = entries[index];
  const count = entries.length;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "VIDEO" || tag === "AUDIO") return;
      if (event.key === "ArrowRight" && index < count - 1) setIndex(index + 1);
      if (event.key === "ArrowLeft" && index > 0) setIndex(index - 1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [index, count]);
  if (!entry) return null;
  const kind = previewKind(entry.path, entry.mime);
  const inline = source.file(entry.id, true);
  return (
    <Modal
      size="xl"
      className="preview-modal"
      title={entry.name}
      subtitle={`${count > 1 ? `${index + 1} of ${count} · ` : ""}${bytes(entry.size)}`}
      onClose={onClose}
      actions={
        <>
          {kind === "image" && (
            <Button
              size="sm"
              variant="ghost"
              icon={<ExternalLink size={16} />}
              aria-label="Open original in a new tab"
              title="Open original in a new tab"
              onClick={() => window.open(inline, "_blank", "noopener")}
            >
              Original
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            icon={<Download size={16} />}
            onClick={() => download(source.file(entry.id), entry.name)}
          >
            Download
          </Button>
        </>
      }
    >
      <div className="preview-stage">
        {count > 1 && (
          <IconButton
            className={`preview-nav prev${index === 0 ? " is-end" : ""}`}
            variant="secondary"
            label="Previous file"
            icon={<ChevronLeft size={20} />}
            disabled={index === 0}
            aria-hidden={index === 0 || undefined}
            onClick={() => setIndex(index - 1)}
          />
        )}
        <div className="preview-content preview-fill">
          <FilePreview key={entry.id} entry={entry} source={source} />
        </div>
        {count > 1 && (
          <IconButton
            className={`preview-nav next${index === count - 1 ? " is-end" : ""}`}
            variant="secondary"
            label="Next file"
            icon={<ChevronRight size={20} />}
            disabled={index === count - 1}
            aria-hidden={index === count - 1 || undefined}
            onClick={() => setIndex(index + 1)}
          />
        )}
      </div>
    </Modal>
  );
}
