// The node-derived half of an ItemSummary, computed in one pass over an item's ready nodes and
// cached in items.summary. Item-row fields and live flags are merged in when it is read.
import type { ItemSummary, NodeKind, NodeRef } from "../../../shared/model.ts";

export type SummaryNode = {
  id: string;
  parent: string | null;
  name: string;
  kind: NodeKind;
  size: number;
  mime: string;
  position: number;
  /** The first characters of a text node's content. */
  excerpt: string | null;
  /** A text node's length in characters. */
  chars: number | null;
};

export type StoredSummary = Pick<
  ItemSummary,
  "files" | "texts" | "folders" | "bytes" | "topFiles" | "topFolders" | "preview" | "mosaic" | "textExcerpt"
> & {
  /** The derived display name; null when the item holds nothing yet. */
  name: string | null;
};

export const EXCERPT_CHARS = 280;
const MOSAIC_SIZE = 4;

const isImage = (n: SummaryNode) => n.mime.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(n.name);
/** Preview preference: images, then PDFs, then videos, then anything else. */
function previewRank(n: SummaryNode) {
  if (isImage(n) || /\.heic$/i.test(n.name)) return 0;
  if (n.mime === "application/pdf" || /\.pdf$/i.test(n.name)) return 1;
  if (n.mime.startsWith("video/")) return 2;
  return 3;
}

/**
 * The name of an item nobody named, built the way the composer shows a draft:
 * "a.png", "a.png + 2 more", "a.png + 2 more + text", "Photos + text". `first` is the first
 * top-level file or folder to arrive and `topLevel` counts all of them. An item holding only text
 * is named "Text · 38 characters": text is often a password or a private note, and the name is
 * shown in lists, titles and notifications where its content must not appear.
 */
export function autoName(first: string | null, topLevel: number, textChars: number | null): string | null {
  if (first !== null)
    return first + (topLevel > 1 ? ` + ${topLevel - 1} more` : "") + (textChars !== null ? " + text" : "");
  if (textChars !== null) return `Text · ${textChars.toLocaleString("en-US")} character${textChars === 1 ? "" : "s"}`;
  return null;
}

export function summarize(nodes: SummaryNode[]): StoredSummary {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const paths = new Map<string, string>();
  const pathOf = (n: SummaryNode): string => {
    let path = paths.get(n.id);
    if (path === undefined) {
      const parent = n.parent === null ? undefined : byId.get(n.parent);
      path = parent ? `${pathOf(parent)}/${n.name}` : n.name;
      paths.set(n.id, path);
    }
    return path;
  };
  const depths = new Map<string, number>();
  const depth = (n: SummaryNode) => {
    let d = depths.get(n.id);
    if (d === undefined) depths.set(n.id, (d = pathOf(n).split("/").length));
    return d;
  };
  const byPath = (a: SummaryNode, b: SummaryNode) => (pathOf(a) < pathOf(b) ? -1 : pathOf(a) > pathOf(b) ? 1 : 0);
  const shallowFirst = (a: SummaryNode, b: SummaryNode) => depth(a) - depth(b) || byPath(a, b);
  const byPosition = (a: SummaryNode, b: SummaryNode) => a.position - b.position;
  const ref = (n: SummaryNode): NodeRef => ({
    id: n.id,
    name: n.name,
    path: pathOf(n),
    kind: n.kind,
    size: n.size,
    mime: n.mime,
  });

  const files = nodes.filter((n) => n.kind === "file");
  const texts = nodes.filter((n) => n.kind === "text");
  const top = nodes.filter((n) => n.parent === null && n.kind !== "text").sort(byPosition);
  const firstText = [...texts].sort(byPosition)[0];
  const excerptText = [...texts].sort(byPath)[0];
  const preview = [...files].sort((a, b) => previewRank(a) - previewRank(b) || shallowFirst(a, b))[0] ?? excerptText;
  const images = files.filter(isImage).sort(shallowFirst).slice(0, MOSAIC_SIZE);

  return {
    name: autoName(top[0]?.name ?? null, top.length, firstText ? (firstText.chars ?? 0) : null),
    files: files.length,
    texts: texts.length,
    folders: nodes.length - files.length - texts.length,
    bytes: [...files, ...texts].reduce((sum, n) => sum + n.size, 0),
    topFiles: top.filter((n) => n.kind === "file").length,
    topFolders: top.filter((n) => n.kind === "folder").length,
    preview: preview ? ref(preview) : null,
    mosaic: files.length + texts.length > 1 && images.length > 1 ? images.map(ref) : [],
    textExcerpt: excerptText?.excerpt ?? null,
  };
}
