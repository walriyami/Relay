import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { LIMITS } from "../../api";
import { addSelection, getDraft, setText } from "../../lib/draft";
import { collectDroppedSelection, dragHasFiles, skippedNotice } from "../../drop-selection";
import { plural } from "../../lib/format";
import { toast } from "../../components/ui";
import { Composer } from "./Composer";
import { RecentGrid } from "../library/FilesPage";

// A dialog on top owns the keyboard and the pointer; nothing lands in the draft behind it.
const modalOpen = () => document.body.classList.contains("modal-open");

export function SendPage() {
  const [dragging, setDragging] = useState(false);
  // Files found so far while a dropped folder is read; null when not reading.
  const [reading, setReading] = useState<number | null>(null);
  // Pasting files anywhere on Send adds them to the selection; pasted text goes in the text box.
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (modalOpen()) return;
      const files = Array.from(event.clipboardData?.files || []);
      if (!files.length) {
        // Pasting text outside any input puts it in the message box (and starts the next transfer
        // if a finished one is showing). Text already being written is never replaced.
        const target = event.target as HTMLElement | null;
        const editing = !!target?.closest?.("input, textarea, [contenteditable]");
        const text = event.clipboardData?.getData("text/plain") || "";
        if (editing || !text.trim() || getDraft().text.trim()) return;
        event.preventDefault();
        setText(text.slice(0, LIMITS.textBytes));
        window.dispatchEvent(new Event("relay-show-text"));
        return;
      }
      event.preventDefault();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      addSelection(
        files.map((file, i) => ({
          file,
          path: /^image\.\w+$/i.test(file.name)
            ? `Pasted ${stamp}${files.length > 1 ? `-${i + 1}` : ""}.${file.name.split(".").pop()}`
            : file.name,
        })),
      );
    };
    // Dropping anywhere on the page adds to the selection. Nothing uploads until a destination is chosen.
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
      const selection = await collectDroppedSelection(event.dataTransfer!.items, setReading);
      setReading(null);
      addSelection(selection.files, selection.folders);
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
  return (
    <div className="page">
      <h1 className="visually-hidden">Send</h1>
      <Composer>
        <RecentGrid />
      </Composer>
      {(dragging || reading !== null) && (
        <div className="drop-overlay" aria-hidden={reading === null} role={reading === null ? undefined : "status"}>
          <div>
            <Upload size={32} />
            <strong>{reading === null ? "Drop to add" : "Reading what you dropped…"}</strong>
            <span>
              {reading ? `${plural(reading, "file")} found so far` : "Nothing uploads until you choose where it goes."}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
