import { useEffect, useRef, useState } from "react";
import { File as FileIcon, FileArchive, FileText, Film, Folder, Image as ImageIcon, Music, Type } from "lucide-react";
import { extension, kindLabel, previewKind } from "../lib/format";
import { pdfThumbnail } from "../lib/pdf";
import type { ContentSource } from "../lib/source";
import { useInView } from "./ui";

export type ThumbEntry = {
  id?: string | null;
  path: string;
  mime?: string | null;
  size?: number | null;
  kind?: string | null;
  text?: string | null;
};

// Small helpers keep expensive previews bounded: two at a time, cached, only when visible.
let active = 0;
const queue: Array<() => void> = [];
async function slot<T>(work: () => Promise<T>) {
  if (active >= 2) await new Promise<void>((r) => queue.push(r));
  else active++;
  try {
    return await work();
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}
const cache = new Map<string, string>();
function remember(key: string, value: string) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > 120) cache.delete(cache.keys().next().value!);
}
const localIds = new WeakMap<File, number>();
let localSerial = 0;
const localKey = (file: File) => {
  if (!localIds.has(file)) localIds.set(file, ++localSerial);
  return `local:${localIds.get(file)}`;
};

async function textExcerpt(url: string | undefined, file: File | undefined) {
  let buffer: ArrayBuffer;
  if (file) buffer = await file.slice(0, 4096).arrayBuffer();
  else {
    const response = await fetch(url!, {
      headers: { Range: "bytes=0-4095" },
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("unavailable");
    if (response.status !== 206) {
      // Never read an entire file for a thumbnail.
      const reader = response.body?.getReader();
      const first = await reader?.read();
      void reader?.cancel();
      buffer = (first?.value || new Uint8Array()).slice(0, 4096).buffer;
    } else buffer = await response.arrayBuffer();
  }
  const bytes = new Uint8Array(buffer);
  let zeros = 0;
  for (const b of bytes.subarray(0, 1024)) if (b === 0) zeros++;
  if (zeros > 4) throw new Error("binary");
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(0, 1200);
}

export function FileTypeIcon({
  path,
  mime,
  kind,
  size = 28,
}: {
  path: string;
  mime?: string | null;
  kind?: string | null;
  size?: number;
}) {
  if (kind === "folder") return <Folder size={size} />;
  if (kind === "text") return <Type size={size} />;
  const type = previewKind(path, mime);
  const ext = extension(path);
  if (["zip", "gz", "tgz", "rar", "7z", "tar", "dmg", "iso"].includes(ext)) return <FileArchive size={size} />;
  if (type === "image") return <ImageIcon size={size} />;
  if (type === "video") return <Film size={size} />;
  if (type === "audio") return <Music size={size} />;
  if (type === "pdf" || type === "text") return <FileText size={size} />;
  return <FileIcon size={size} />;
}

function Fallback({ entry, compact, label }: { entry: ThumbEntry; compact?: boolean; label?: string }) {
  return (
    <div className="thumb-icon">
      <FileTypeIcon path={entry.path} mime={entry.mime} kind={entry.kind} size={compact ? 20 : 32} />
      {!compact && entry.kind !== "folder" && entry.kind !== "text" && (
        <span className="thumb-ext">{label || kindLabel(entry.path)}</span>
      )}
    </div>
  );
}

// A bounded preview: server thumbnails for images, first PDF page from byte ranges, a short text
// excerpt, a poster frame for a video you picked, or a file-type icon. Uploaded videos show an icon:
// a poster frame would mean fetching the original.
export function Thumbnail({
  entry,
  source,
  file,
  compact = false,
  className = "",
}: {
  entry: ThumbEntry;
  source?: ContentSource;
  file?: File;
  compact?: boolean;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const visible = useInView(box);
  const [failed, setFailed] = useState(false);
  const [data, setData] = useState<string>("");
  const [local, setLocal] = useState("");
  const type =
    entry.kind === "text" ? "inline-text" : entry.kind === "folder" ? "folder" : previewKind(entry.path, entry.mime);
  const remote = source && entry.id;
  const size = entry.size ?? file?.size ?? 0;
  // An empty file has nothing to preview; say so instead of fetching nothing.
  const empty = size === 0 && (entry.size === 0 || !!file) && type !== "folder" && type !== "inline-text";

  useEffect(() => {
    setFailed(false);
    setData("");
  }, [entry.id, entry.path, file]);

  // Local object URLs for images and videos picked in the composer.
  useEffect(() => {
    if (!file || !visible || empty) return;
    if ((type === "image" && size <= 16 * 1024 ** 2) || (type === "video" && !compact)) {
      const url = URL.createObjectURL(file);
      setLocal(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [file, visible, type, size, compact, empty]);

  useEffect(() => {
    if (!visible || failed || empty || (type !== "pdf" && type !== "text")) return;
    if (!file && !remote) return;
    if (type === "text" && compact) return;
    const key = `${type}:${file ? localKey(file) : source!.file(entry.id!)}`;
    const hit = cache.get(key);
    if (hit) {
      setData(hit);
      return;
    }
    let live = true;
    void slot(async () => {
      if (!live) return "";
      if (type === "pdf") {
        if (size > 2 * 1024 ** 3) throw new Error("large");
        return pdfThumbnail(file, file ? "" : source!.file(entry.id!, true), size);
      }
      return textExcerpt(file ? undefined : source!.file(entry.id!), file);
    })
      .then((value) => {
        if (!value) return;
        remember(key, value);
        if (live) setData(value);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [visible, failed, empty, type, entry.id, file, source, compact, size, remote]);

  let content;
  if (empty) content = <Fallback entry={entry} compact={compact} label="Empty file" />;
  else if (type === "inline-text")
    content = entry.text ? (
      <div className="thumb-text">{entry.text.slice(0, compact ? 80 : 600)}</div>
    ) : (
      <Fallback entry={entry} compact={compact} />
    );
  else if (failed || type === "folder" || type === "none" || type === "audio")
    content = <Fallback entry={entry} compact={compact} />;
  else if (type === "image") {
    const url = file ? local : remote ? source.thumb(entry.id!, "s") : "";
    content = url ? (
      <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
    ) : (
      <Fallback entry={entry} compact={compact} />
    );
  } else if (type === "pdf")
    content = data ? (
      <img src={data} alt="" className="thumb-page" draggable={false} />
    ) : (
      <Fallback entry={entry} compact={compact} />
    );
  else if (type === "text")
    content = data ? <div className="thumb-text mono">{data}</div> : <Fallback entry={entry} compact={compact} />;
  else if (type === "video") {
    content = local ? (
      <>
        <video
          src={`${local}#t=0.5`}
          preload="metadata"
          muted
          playsInline
          onError={() => setFailed(true)}
          tabIndex={-1}
        />
        <span className="thumb-badge-play" aria-hidden>
          <Film size={14} />
        </span>
      </>
    ) : (
      <Fallback entry={entry} compact={compact} />
    );
  }
  return (
    <div ref={box} className={`thumb thumb-${type} ${compact ? "thumb-compact" : ""} ${className}`} aria-hidden>
      {content}
    </div>
  );
}
