import { zip, type ZipEntry } from "./zip";

// Saving what arrived. Phones and tablets hand the files to the share sheet, where photos can go
// straight to the photo library; computers download them, several at once as one ZIP.

export const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

/** Whether the share sheet can take these files here. */
export function canShare(files: File[]) {
  try {
    return touch && !!navigator.canShare?.({ files });
  } catch {
    return false;
  }
}

/**
 * Opens the share sheet with `files`. Call it straight from a tap: browsers only allow it then.
 * Resolves false when it wasn't shown; true when it was, or was dismissed.
 */
export async function share(files: File[]) {
  try {
    await navigator.share({ files });
    return true;
  } catch (error) {
    return error instanceof DOMException && error.name === "AbortError";
  }
}

/** Downloads one file under its own name. */
export function downloadFile(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // The download has its own hold on the file by the time this runs.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Downloads every entry as one archive named `name`.zip, folders and all. */
export function downloadZip(entries: ZipEntry[], folders: string[], name: string) {
  downloadFile(zip(entries, folders), `${safeName(name)}.zip`);
}

/** A name every file system takes. */
function safeName(name: string) {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what's replaced.
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim() || "Nearby";
}
