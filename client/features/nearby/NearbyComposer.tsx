import { useEffect, useRef, useState } from "react";
import { Clipboard, FileText, Folder, Loader2, Paperclip, Plus, X } from "lucide-react";
import { DocumentArt } from "../../components/DocumentArt";
import { Button, toast } from "../../components/ui";
import { fromFileList, type DraftItem } from "../../lib/draft";
import { bytes } from "../../lib/format";
import { touch } from "../../lib/nearby/save";
import {
  addToSelection,
  clearSelection,
  getSelection,
  removeFromSelection,
  restoreSelection,
  setSelectionText,
  useSelection,
} from "../../lib/nearby/selection";
import { allFiles, composition } from "../library/actions";
import { SelectionRow } from "../send/Composer";

const PREVIEW = 6;
const UNDO = "nearby-undo";
/** Text pasted or typed here; a transfer carries any amount, but a text box this long stops being usable. */
export const TEXT_CHARS = 1024 * 1024;

/** "4 files, 1 folder" and whether there is text, with every file counted when folders hide them. */
export function describe(items: DraftItem[], hasText: boolean) {
  const files = items.filter((i) => i.kind === "file").length;
  const total = items.reduce((n, i) => n + (i.kind === "file" ? 1 : i.files.length), 0);
  const parts = composition(files, items.length - files, hasText ? 1 : 0);
  return files < items.length && total ? `${parts} · ${allFiles(total, files)}` : parts;
}

/** What Nearby sends: files and folders, or text, like Send's box. */
export function NearbyComposer() {
  const selection = useSelection();
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<"files" | "text">("files");
  const [shown, setShown] = useState(PREVIEW);
  const [pasting, setPasting] = useState(false);
  const [pasteError, setPasteError] = useState("");
  const { items, text } = selection;
  const hasText = text.trim().length > 0;
  const size = items.reduce((n, i) => n + i.size, 0);
  const total = items.reduce((n, i) => n + (i.kind === "file" ? 1 : i.files.length), 0);

  function switchMode(next: "files" | "text") {
    setMode(next);
    if (next === "text") requestAnimationFrame(() => textArea.current?.focus());
  }
  // Text pasted elsewhere on the page opens the text box so you can see it landed.
  useEffect(() => {
    const show = () => switchMode("text");
    window.addEventListener("relay-nearby-text", show);
    return () => window.removeEventListener("relay-nearby-text", show);
  }, []);
  // New picks bring the files back into view.
  const count = useRef(items.length);
  useEffect(() => {
    if (!items.length) setShown(PREVIEW);
    if (items.length > count.current) setMode("files");
    count.current = items.length;
  }, [items.length]);

  async function paste() {
    setPasteError("");
    setPasting(true);
    const el = textArea.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    try {
      const clip = await navigator.clipboard.readText();
      setSelectionText((text.slice(0, start) + clip + text.slice(end)).slice(0, TEXT_CHARS));
      requestAnimationFrame(() => {
        textArea.current?.focus();
        textArea.current?.setSelectionRange(start + clip.length, start + clip.length);
      });
    } catch {
      setPasteError("This browser won’t let Relay read the clipboard. Paste into the box with ⌘V or Ctrl+V.");
    } finally {
      setPasting(false);
    }
  }
  function clearFiles() {
    const previous = getSelection();
    restoreSelection({ ...previous, items: [] });
    toast("Files cleared", {
      key: UNDO,
      action: { label: "Undo", onClick: () => restoreSelection({ ...getSelection(), items: previous.items }) },
    });
  }

  return (
    <section className="composer card-surface nearby-composer" aria-label="What to send">
      <input
        ref={filesInput}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        data-testid="nearby-file-input"
        onChange={(e) => {
          if (e.target.files?.length) addToSelection(fromFileList(e.target.files));
          e.target.value = "";
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        aria-hidden
        tabIndex={-1}
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => {
          if (e.target.files?.length) addToSelection(fromFileList(e.target.files, true));
          e.target.value = "";
        }}
      />
      <div className="composer-head">
        <span className={`composer-summary${items.length || hasText ? "" : " muted"}`}>
          {items.length || hasText
            ? `${describe(items, hasText)}${size ? ` · ${bytes(size)}` : ""}`
            : "Nothing added yet"}
        </span>
        <div className="composer-mode" role="group" aria-label="Content type" data-mode={mode}>
          <button type="button" aria-pressed={mode === "files"} onClick={() => switchMode("files")}>
            Files
            {total > 0 && <span className="composer-mode-count">{total.toLocaleString()}</span>}
          </button>
          <button type="button" aria-pressed={mode === "text"} onClick={() => switchMode("text")}>
            Text
            {hasText && <span className="composer-mode-dot" aria-label="has text" />}
          </button>
        </div>
      </div>
      <div className="composer-pane" hidden={mode !== "files"}>
        {items.length === 0 ? (
          <button type="button" className="composer-drop" onClick={() => filesInput.current?.click()}>
            <DocumentArt />
            <strong>{touch ? "Choose photos or files" : "Drop files or folders"}</strong>
            <span className="composer-browse">Browse files</span>
          </button>
        ) : (
          <ul className="selection-list" aria-label="Selected items">
            {items.slice(0, shown).map((item) => (
              <SelectionRow key={item.key} item={item} onRemove={() => removeFromSelection(item.key)} />
            ))}
            {items.length > shown && (
              <li className="selection-more">
                <Button size="sm" variant="ghost" onClick={() => setShown(items.length)}>
                  Show all {items.length.toLocaleString()}
                </Button>
              </li>
            )}
          </ul>
        )}
        <div className={`composer-tools${items.length ? "" : " is-centered"}`}>
          {items.length > 0 && (
            <button type="button" onClick={() => filesInput.current?.click()}>
              <Plus size={15} aria-hidden /> Add files
            </button>
          )}
          {!touch && (
            <button type="button" onClick={() => folderInput.current?.click()}>
              <Folder size={15} aria-hidden /> {items.length ? "Add folder" : "Choose folder"}
            </button>
          )}
          {items.length > 0 && (
            <button type="button" className="composer-tools-end" onClick={clearFiles}>
              <X size={15} aria-hidden /> Clear
            </button>
          )}
        </div>
        {hasText && (
          <div className="composer-peek">
            <FileText size={16} aria-hidden />
            <span>{text.trim().split("\n")[0]}</span>
            <button type="button" onClick={() => switchMode("text")}>
              Edit text
            </button>
          </div>
        )}
      </div>
      <div className="composer-pane composer-write" hidden={mode !== "text"}>
        <label className="visually-hidden" htmlFor="nearby-text">
          Text
        </label>
        <textarea
          id="nearby-text"
          ref={textArea}
          placeholder="Write or paste text…"
          value={text}
          maxLength={TEXT_CHARS}
          readOnly={pasting}
          aria-busy={pasting || undefined}
          spellCheck
          onChange={(e) => {
            setSelectionText(e.target.value);
            setPasteError("");
          }}
        />
        <div className="composer-tools">
          <button type="button" aria-disabled={pasting || undefined} onClick={() => !pasting && void paste()}>
            {pasting ? <Loader2 size={15} className="spin" aria-hidden /> : <Clipboard size={15} aria-hidden />} Paste
          </button>
          <button
            type="button"
            disabled={!text.length}
            onClick={() => {
              const previous = text;
              setSelectionText("");
              setPasteError("");
              textArea.current?.focus();
              toast("Text cleared", {
                key: UNDO,
                action: { label: "Undo", onClick: () => setSelectionText(previous) },
              });
            }}
          >
            <X size={15} aria-hidden /> Clear
          </button>
        </div>
        {pasteError && (
          <p className="field-error" role="alert">
            {pasteError}
          </p>
        )}
        {items.length > 0 && (
          <div className="composer-peek">
            <Paperclip size={16} aria-hidden />
            <span>
              {describe(items, false)} · {bytes(size)}
            </span>
            <button type="button" onClick={() => switchMode("files")}>
              Show files
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/** Takes the selection to send, and empties the box for the next thing. */
export function takeSelection() {
  const { items, text } = getSelection();
  const files: { file: File; path: string }[] = [];
  const folders: string[] = [];
  for (const item of items)
    if (item.kind === "file") files.push({ file: item.file, path: item.path });
    else {
      files.push(...item.files);
      folders.push(...item.folders);
    }
  clearSelection();
  return { files, folders, text: text.trim() ? text : "" };
}
