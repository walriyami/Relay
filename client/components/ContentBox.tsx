import { useEffect, useRef, useState, type RefObject } from "react";
import { Clipboard, FileText, Folder, Loader2, Paperclip, Plus, X } from "lucide-react";
import { fromFileList, type DraftItem, type PickedDraftFile } from "../lib/draft";
import { bytes, plural } from "../lib/format";
import { allFiles, composition } from "../features/library/actions";
import { DocumentArt } from "./DocumentArt";
import { Thumbnail } from "./Thumbnail";
import { Button, IconButton, toast } from "./ui";
import { UserText } from "./UserText";

// Collapsed selections show a few rows; more on request.
const PREVIEW = 6;
const PAGE = 60;
// Phones and tablets can't drop files or pick folders.
const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

export type ContentMode = "files" | "text";

/**
 * "4 files, 1 folder" for the picks, plus "and text" when there is text. Folders hide how much they
 * hold, so a selection with folders also counts every file: "1 folder · 1,200 files".
 */
function describePicks(items: DraftItem[], hasText: boolean) {
  const files = items.filter((i) => i.kind === "file").length;
  const total = items.reduce((n, i) => n + (i.kind === "file" ? 1 : i.files.length), 0);
  const parts = composition(files, items.length - files, hasText ? 1 : 0);
  return files < items.length && total ? `${parts} · ${allFiles(total, files)}` : parts;
}

/**
 * What you're about to send, wherever it goes: files and folders, text, or both, in one frame with a
 * Files | Text switch. Send, Nearby and a request's upload page all use it; each keeps the selection
 * in its own place and decides what happens next.
 */
export function ContentBox({
  items,
  text,
  textMax,
  onFiles,
  onRemove,
  onClearFiles,
  onText,
  textId,
  showTextEvent,
  undoKey,
  pickers,
  fileInputTestId,
}: {
  items: DraftItem[];
  text: string;
  textMax: number;
  onFiles: (files: PickedDraftFile[]) => void;
  onRemove: (key: string) => void;
  /** Empties the files and returns how to put them back, for Undo. */
  onClearFiles: () => () => void;
  onText: (text: string) => void;
  /** The text box's id, unique on the page. */
  textId: string;
  /** Fired on window when text was pasted elsewhere on the page, so the text box shows it landed. */
  showTextEvent: string;
  /** Toast key for Undo after clearing, so a newer clear replaces the older offer. */
  undoKey: string;
  /** Pickers the page keeps itself (see `FilePickers`), for pages that open them from elsewhere too. */
  pickers?: { files: RefObject<HTMLInputElement | null>; folder: RefObject<HTMLInputElement | null> };
  fileInputTestId?: string;
}) {
  const ownFiles = useRef<HTMLInputElement>(null);
  const ownFolder = useRef<HTMLInputElement>(null);
  const filesInput = pickers?.files ?? ownFiles;
  const folderInput = pickers?.folder ?? ownFolder;
  const textArea = useRef<HTMLTextAreaElement>(null);
  const focusText = useRef(false);
  // Text kept from before (a reload, or switching pages) opens where it was typed.
  const [mode, setMode] = useState<ContentMode>(() => (text && !items.length ? "text" : "files"));
  const [shown, setShown] = useState(PREVIEW);
  const [pasting, setPasting] = useState(false);
  const [pasteError, setPasteError] = useState("");
  const hasText = text.trim().length > 0;
  const size = items.reduce((n, i) => n + i.size, 0);
  const fileTotal = items.reduce((n, i) => n + (i.kind === "file" ? 1 : i.files.length), 0);

  function switchMode(next: ContentMode) {
    setMode(next);
    if (next !== "text") return;
    // The text box takes focus once it is shown, unless focus has moved on by then.
    const from = document.activeElement;
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now === from || !now || now === document.body) textArea.current?.focus();
    });
  }
  useEffect(() => {
    const show = () => switchMode("text");
    window.addEventListener(showTextEvent, show);
    return () => window.removeEventListener(showTextEvent, show);
  }, [showTextEvent]);
  // New picks bring the files back into view.
  const count = useRef(items.length);
  useEffect(() => {
    if (!items.length) setShown(PREVIEW);
    if (items.length > count.current) setMode("files");
    count.current = items.length;
  }, [items.length]);
  useEffect(() => {
    if (pasting || !focusText.current) return;
    focusText.current = false;
    textArea.current?.focus();
  }, [pasting]);

  async function paste() {
    setPasteError("");
    setPasting(true);
    const el = textArea.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    try {
      const clip = await navigator.clipboard.readText();
      onText((text.slice(0, start) + clip + text.slice(end)).slice(0, textMax));
      requestAnimationFrame(() => {
        textArea.current?.focus();
        textArea.current?.setSelectionRange(start + clip.length, start + clip.length);
      });
    } catch {
      setPasteError("This browser won’t let Relay read the clipboard. Paste into the box with ⌘V or Ctrl+V.");
      // The box is read-only while pasting; it takes focus once it can be typed in again.
      focusText.current = true;
    } finally {
      setPasting(false);
    }
  }
  function clearFiles() {
    const undo = onClearFiles();
    toast("Files cleared", { key: undoKey, action: { label: "Undo", onClick: undo } });
  }
  function clearText() {
    const previous = text;
    onText("");
    setPasteError("");
    textArea.current?.focus();
    toast("Text cleared", { key: undoKey, action: { label: "Undo", onClick: () => onText(previous) } });
  }

  return (
    // Laid out as part of the frame around it (the composer's column), not a box of its own.
    <div className="content-box">
      {!pickers && <FilePickers files={filesInput} folder={folderInput} onFiles={onFiles} testId={fileInputTestId} />}
      <div className="composer-head">
        <span className="composer-summary">
          {(items.length > 0 || hasText) && `${describePicks(items, hasText)}${size ? ` · ${bytes(size)}` : ""}`}
        </span>
        <div className="composer-mode" role="group" aria-label="Content type" data-mode={mode}>
          <button type="button" aria-pressed={mode === "files"} onClick={() => switchMode("files")}>
            Files
            {fileTotal > 0 && <span className="composer-mode-count">{fileTotal.toLocaleString()}</span>}
          </button>
          <button type="button" aria-pressed={mode === "text"} onClick={() => switchMode("text")}>
            Text
            {hasText && <span className="composer-mode-dot" aria-label="has text" />}
          </button>
        </div>
      </div>
      <div className="composer-pane" hidden={mode !== "files"}>
        {items.length === 0 ? (
          // The whole area takes a click, for a mouse; the button is the one action, for everyone.
          <div
            className="composer-drop"
            onClick={(event) => {
              if (!(event.target as Element).closest("button")) filesInput.current?.click();
            }}
          >
            <DocumentArt />
            <strong>{touch ? "Add photos, files or text" : "Drop files or folders here"}</strong>
            <Button variant="primary" icon={<Plus size={18} aria-hidden />} onClick={() => filesInput.current?.click()}>
              {touch ? "Choose photos or files" : "Choose files"}
            </Button>
          </div>
        ) : (
          <ul className="selection-list" aria-label="Selected items">
            {items.slice(0, shown).map((item) => (
              <SelectionRow key={item.key} item={item} onRemove={() => onRemove(item.key)} />
            ))}
            {items.length > shown && (
              <li className="selection-more">
                <Button size="sm" variant="ghost" onClick={() => setShown(shown === PREVIEW ? PAGE : items.length)}>
                  {shown === PREVIEW && items.length > PAGE
                    ? `Show ${PAGE - PREVIEW} more`
                    : `Show all ${items.length.toLocaleString()}`}
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
        <label className="visually-hidden" htmlFor={textId}>
          Text
        </label>
        <textarea
          id={textId}
          ref={textArea}
          placeholder="Write or paste text…"
          value={text}
          maxLength={textMax}
          readOnly={pasting}
          aria-busy={pasting || undefined}
          spellCheck
          onChange={(e) => {
            onText(e.target.value);
            setPasteError("");
          }}
        />
        <div className="composer-tools">
          <button
            type="button"
            // Unavailable rather than disabled, so focus stays here while the browser asks.
            aria-disabled={pasting || undefined}
            onClick={() => !pasting && void paste()}
          >
            {pasting ? <Loader2 size={15} className="spin" aria-hidden /> : <Clipboard size={15} aria-hidden />} Paste
          </button>
          <button type="button" disabled={!text.length} onClick={clearText}>
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
              {describePicks(items, false)} · {bytes(size)}
            </span>
            <button type="button" onClick={() => switchMode("files")}>
              Show files
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The hidden pickers behind Browse files and Choose folder. */
export function FilePickers({
  files,
  folder,
  onFiles,
  testId,
  folderTestId,
}: {
  files: RefObject<HTMLInputElement | null>;
  folder: RefObject<HTMLInputElement | null>;
  onFiles: (files: PickedDraftFile[]) => void;
  testId?: string;
  folderTestId?: string;
}) {
  return (
    <>
      <input
        ref={files}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        data-testid={testId}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(fromFileList(e.target.files));
          e.target.value = "";
        }}
      />
      <input
        ref={folder}
        type="file"
        hidden
        aria-hidden
        tabIndex={-1}
        data-testid={folderTestId}
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(fromFileList(e.target.files, true));
          e.target.value = "";
        }}
      />
    </>
  );
}

export function SelectionRow({ item, onRemove }: { item: DraftItem; onRemove: () => void }) {
  return (
    <li className="selection-row">
      {item.kind === "folder" ? (
        <div className="thumb thumb-compact thumb-folder">
          <div className="thumb-icon">
            <Folder size={20} />
          </div>
        </div>
      ) : (
        <Thumbnail compact file={item.file} entry={{ path: item.path, mime: item.file.type, size: item.size }} />
      )}
      <div className="selection-text">
        <span className="selection-name" title={item.name}>
          <UserText>{item.name}</UserText>
        </span>
        <span className="muted">
          {item.kind === "folder" ? `Folder · ${plural(item.files.length, "file")} · ` : ""}
          {bytes(item.size)}
        </span>
      </div>
      <IconButton size="sm" label={`Remove ${item.name}`} icon={<X size={16} />} onClick={onRemove} />
    </li>
  );
}
