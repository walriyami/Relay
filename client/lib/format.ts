import { urls } from "../api";

export function bytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const power = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
  const value = n / 1024 ** power;
  const shown = power === 0 ? String(value) : value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
  return `${shown} ${["B", "KB", "MB", "GB", "TB"][power]}`;
}
/** `part` as a share of `whole`, rounded, but never "0%" for something or "100%" for less than all. */
export function percent(part: number, whole: number) {
  if (whole <= 0 || part <= 0) return "0%";
  const ratio = part / whole;
  if (ratio < 0.005) return "<1%";
  if (ratio < 1 && ratio >= 0.995) return ">99%";
  return `${Math.round(ratio * 100)}%`;
}
export const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export function ago(time: number, now = Date.now()) {
  const s = Math.round((now - time) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? "yesterday" : `${d} days ago`;
  return date(time);
}
export function until(time: number, now = Date.now()) {
  const ms = time - now;
  if (ms <= 0) return "expired";
  const h = ms / 3600000;
  if (h < 1) return `in ${Math.max(1, Math.round(ms / 60000))} min`;
  // Hours below a day; from then on days, so a 1-day link reads "in 1 day" like the choice that made it.
  if (h < 23.5) return `in ${Math.round(h)} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "in 1 day" : `in ${d} days`;
}
export const date = (n: number) =>
  new Date(n).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(n).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
export const dateTime = (n: number) =>
  new Date(n).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
export function duration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
}
export const baseName = (path: string) => path.split("/").pop() || path;
export const extension = (path: string) => {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};
export type Preview = "image" | "pdf" | "text" | "video" | "audio" | "none";
const IMAGE = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif", "tif", "tiff", "heic", "heif"]);
const TEXT = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "log",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "css",
  "scss",
  "html",
  "htm",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "zsh",
  "bash",
  "sql",
  "env",
  "srt",
  "vtt",
  "gitignore",
  "dockerfile",
  "makefile",
  "readme",
]);
const VIDEO = new Set(["mp4", "m4v", "webm", "mov", "ogv"]);
const AUDIO = new Set(["mp3", "m4a", "aac", "wav", "ogg", "oga", "flac", "opus"]);
// Chooses how a file can be previewed from its declared type and name, never by sniffing content.
export function previewKind(path: string, mime?: string | null): Preview {
  const type = (mime || "").split(";")[0].trim().toLowerCase();
  const ext = extension(path);
  if (type === "image/svg+xml" || ext === "svg") return "none";
  if (IMAGE.has(ext) || /^image\/(png|jpeg|webp|gif|avif|tiff|heic|heif)$/.test(type)) return "image";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (VIDEO.has(ext) || type.startsWith("video/")) return "video";
  if (AUDIO.has(ext) || type.startsWith("audio/")) return "audio";
  if (
    type.startsWith("text/") ||
    /^application\/(json|xml|javascript|x-sh|x-yaml|toml)/.test(type) ||
    TEXT.has(ext) ||
    TEXT.has(baseName(path).toLowerCase())
  )
    return "text";
  return "none";
}
export function kindLabel(path: string) {
  const ext = extension(path);
  return ext ? ext.toUpperCase().slice(0, 5) : "FILE";
}
export async function copyText(value: string) {
  try {
    // Some browsers leave the promise pending when clipboard access is not granted; don't wait on it forever.
    await Promise.race([
      navigator.clipboard.writeText(value),
      new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard timeout")), 1500)),
    ]);
    return true;
  } catch {
    // The fallback field goes inside the open dialog, if any, so its focus trap doesn't pull focus away.
    const host = document.activeElement?.closest("[role=dialog]") ?? document.body;
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    const previous = document.activeElement as HTMLElement | null;
    host.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    previous?.focus({ preventScroll: true });
    return ok;
  }
}
/** "Text · 38 characters": how lists name text, never by its content, which is often private. */
export function textLabel(text: string) {
  const chars = [...text].length;
  return `Text · ${chars.toLocaleString("en-US")} character${chars === 1 ? "" : "s"}`;
}
/**
 * A preview of the name the server derives from the contents ("photo.png + 2 more + text"), shown
 * before anything is sent. Text alone is named by its length, as the server does.
 */
export function autoName(items: { name: string }[], text: string) {
  const hasText = !!text.trim();
  if (items.length)
    return items[0].name + (items.length > 1 ? ` + ${items.length - 1} more` : "") + (hasText ? " + text" : "");
  return hasText ? textLabel(text) : "Text";
}
export const shareUrl = (token: string) => urls.shareLink(location.origin, token);
