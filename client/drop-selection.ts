export type DroppedSelection = {
  files: { file: File; path: string; selectionId?: string }[];
  folders: { path: string; selectionId: string }[];
  /** Entries the browser could not read (permissions, files removed mid-drop); the rest still count. */
  skipped: number;
};
const isFile = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile;
const isDirectory = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry => entry.isDirectory;

/** Browser file-system calls a folder walk keeps in flight; each one alone is a round trip. */
const WALK_PARALLEL = 16;

type Found = Pick<DroppedSelection, "files" | "folders">;

/**
 * Directory readers return batches; an empty batch marks completion, not an empty folder. Never
 * rejects. `onProgress` reports the files found so far while a large folder is walked. Entries are
 * read several at a time, yet come out in the order a one-by-one walk would give.
 */
export async function collectDroppedSelection(
  items: DataTransferItemList,
  onProgress?: (files: number) => void,
): Promise<DroppedSelection> {
  const result: DroppedSelection = { files: [], folders: [], skipped: 0 };
  let found = 0;
  let active = 0;
  const waiting: (() => void)[] = [];
  // Only the browser call holds a slot, never a folder waiting on its children, so nesting can't deadlock.
  async function limited<T>(request: (resolve: (value: T) => void, reject: (error: unknown) => void) => void) {
    if (active >= WALK_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await new Promise<T>(request);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }
  async function walk(entry: FileSystemEntry, selectionId: string, parent = ""): Promise<Found> {
    const path = parent + entry.name;
    if (isFile(entry)) {
      try {
        const file = await limited<File>((resolve, reject) => entry.file(resolve, reject));
        if (++found % 100 === 0) onProgress?.(found);
        return { files: [{ file, path, selectionId }], folders: [] };
      } catch {
        result.skipped++;
      }
    } else if (isDirectory(entry)) {
      const reader = entry.createReader();
      const children: FileSystemEntry[] = [];
      try {
        for (;;) {
          const batch = await limited<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          children.push(...batch);
        }
      } catch {
        // What was read before the failure still counts.
        result.skipped++;
      }
      const walked = await Promise.all(children.map((child) => walk(child, selectionId, path + "/")));
      return {
        files: walked.flatMap((w) => w.files),
        folders: [{ path, selectionId }, ...walked.flatMap((w) => w.folders)],
      };
    }
    return { files: [], folders: [] };
  }
  // Capture entries synchronously while the browser's drag data store is accessible.
  const roots = Array.from(items, (item, index) => ({
    entry: item.webkitGetAsEntry?.(),
    file: item.getAsFile(),
    selectionId: `drop-root-${index}`,
  }));
  for (const { entry, file, selectionId } of roots) {
    // A dropped file is already in hand. Reading it again through its entry is slower and can fail
    // where getAsFile succeeded (WebKit, for files not backed by disk), so only folders are walked.
    // Folders need the check: Chrome returns a File for them too.
    if (file && !entry?.isDirectory) result.files.push({ file, path: file.name, selectionId });
    else if (entry) {
      const walked = await walk(entry, selectionId);
      for (const f of walked.files) result.files.push(f);
      for (const f of walked.folders) result.folders.push(f);
    }
  }
  return result;
}

/** Whether a drag carries files, rather than text or a link from another page. */
export const dragHasFiles = (event: DragEvent) =>
  !!event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files");

/** Said when some dropped entries couldn't be read; everything else was still added. */
export const skippedNotice = (skipped: number) =>
  skipped === 1
    ? "1 item couldn’t be read and was left out."
    : `${skipped.toLocaleString()} items couldn’t be read and were left out.`;
