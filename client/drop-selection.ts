export type DroppedSelection = {
  files: { file: File; path: string; selectionId?: string }[];
  folders: { path: string; selectionId: string }[];
  /** Entries the browser could not read (permissions, files removed mid-drop); the rest still count. */
  skipped: number;
};
const isFile = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile;
const isDirectory = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry => entry.isDirectory;

/**
 * Directory readers return batches; an empty batch marks completion, not an empty folder. Never
 * rejects. `onProgress` reports the files found so far while a large folder is walked.
 */
export async function collectDroppedSelection(
  items: DataTransferItemList,
  onProgress?: (files: number) => void,
): Promise<DroppedSelection> {
  const result: DroppedSelection = { files: [], folders: [], skipped: 0 };
  async function walk(entry: FileSystemEntry, selectionId: string, parent = "") {
    const path = parent + entry.name;
    try {
      if (isFile(entry)) {
        const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
        result.files.push({ file, path, selectionId });
        if (result.files.length % 100 === 0) onProgress?.(result.files.length);
      } else if (isDirectory(entry)) {
        result.folders.push({ path, selectionId });
        const reader = entry.createReader();
        for (;;) {
          const children = await new Promise<FileSystemEntry[]>((resolve, reject) =>
            reader.readEntries(resolve, reject),
          );
          if (!children.length) break;
          for (const child of children) await walk(child, selectionId, path + "/");
        }
      }
    } catch {
      result.skipped++;
    }
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
    else if (entry) await walk(entry, selectionId);
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
