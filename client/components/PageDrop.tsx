import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { collectDroppedSelection, dragHasFiles, skippedNotice } from "../drop-selection";
import type { PickedDraftFile, PickedFolder } from "../lib/draft";
import { plural } from "../lib/format";
import { toast } from "./ui";

// A dialog on top owns the keyboard and the pointer; nothing lands in the page behind it.
const modalOpen = () => document.body.classList.contains("modal-open");

/**
 * Files dropped or pasted anywhere on a page, and text pasted outside any box. Returns the overlay
 * the page shows while something is dragged over it or a dropped folder is read.
 */
export function usePageDrop({
  onFiles,
  onText,
  getFilesGeneration,
  hint,
}: {
  onFiles: (files: PickedDraftFile[], folders: PickedFolder[]) => void;
  /** Text pasted outside any input; return false to leave it alone. */
  onText: (text: string) => boolean;
  /** An owning selection's explicit clears invalidate folder reads already in flight. */
  getFilesGeneration?: () => number;
  /** Under "Drop to add": what happens next. */
  hint: string;
}) {
  const [dragging, setDragging] = useState(false);
  // Files found so far while a dropped folder is read; null when not reading.
  const [reading, setReading] = useState<number | null>(null);
  const handlers = useRef({ onFiles, onText, getFilesGeneration });
  handlers.current = { onFiles, onText, getFilesGeneration };
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (modalOpen()) return;
      const files = Array.from(event.clipboardData?.files || []);
      if (!files.length) {
        // Text already being written is never touched.
        const target = event.target as HTMLElement | null;
        if (target?.closest?.("input, textarea, [contenteditable]")) return;
        const text = event.clipboardData?.getData("text/plain") || "";
        if (text.trim() && handlers.current.onText(text)) event.preventDefault();
        return;
      }
      event.preventDefault();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      handlers.current.onFiles(
        files.map((file, i) => ({
          file,
          path: /^image\.\w+$/i.test(file.name)
            ? `Pasted ${stamp}${files.length > 1 ? `-${i + 1}` : ""}.${file.name.split(".").pop()}`
            : file.name,
        })),
        [],
      );
    };
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!dragHasFiles(event) || modalOpen()) return;
      event.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!dragHasFiles(event) || modalOpen()) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!dragHasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = async (event: DragEvent) => {
      if (!dragHasFiles(event) || modalOpen()) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      setReading(0);
      const generation = handlers.current.getFilesGeneration;
      const started = generation?.();
      const selection = await collectDroppedSelection(event.dataTransfer!.items, setReading);
      setReading(null);
      if (generation && generation() !== started) return;
      handlers.current.onFiles(selection.files, selection.folders);
      if (selection.skipped) toast(skippedNotice(selection.skipped), { tone: "error" });
    };
    const onDrop = (event: DragEvent) => void drop(event);
    document.addEventListener("paste", paste);
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("paste", paste);
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", onDrop);
    };
  }, []);
  if (!dragging && reading === null) return null;
  return (
    <div className="drop-overlay" aria-hidden={reading === null} role={reading === null ? undefined : "status"}>
      <div>
        <Upload size={32} />
        <strong>{reading === null ? "Drop to add" : "Reading what you dropped…"}</strong>
        <span>{reading ? `${plural(reading, "file")} found so far` : hint}</span>
      </div>
    </div>
  );
}
