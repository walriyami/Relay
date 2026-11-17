import { ContentBox } from "../../components/ContentBox";
import {
  addToSelection,
  clearSelection,
  getSelection,
  removeFromSelection,
  restoreSelection,
  setSelectionText,
  useSelection,
} from "../../lib/nearby/selection";

/** Text pasted or typed here; a transfer carries any amount, but a text box this long stops being usable. */
export const TEXT_CHARS = 1024 * 1024;

/** What Nearby sends: files and folders, or text, in the same box as Send. */
export function NearbyComposer() {
  const { items, text } = useSelection();
  return (
    <section className="composer card-surface nearby-composer" aria-label="What to send">
      <ContentBox
        items={items}
        text={text}
        textMax={TEXT_CHARS}
        onFiles={(files) => addToSelection(files)}
        onRemove={removeFromSelection}
        onClearFiles={() => {
          const previous = getSelection();
          restoreSelection({ ...previous, items: [] });
          return () => restoreSelection({ ...getSelection(), items: previous.items });
        }}
        onText={setSelectionText}
        textId="nearby-text"
        showTextEvent="relay-nearby-text"
        undoKey="nearby-undo"
        fileInputTestId="nearby-file-input"
      />
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
