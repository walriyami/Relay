import { useSyncExternalStore } from "react";
import { normalizeSelection, type DraftItem, type PickedDraftFile, type PickedFolder } from "../draft";

// What Nearby's composer holds: its own, apart from Send's draft, since it goes somewhere else and
// in another way. It lives as long as the tab, and goes on sign-out.

type Selection = { items: DraftItem[]; text: string };
let selection: Selection = { items: [], text: "" };
const listeners = new Set<() => void>();
function set(next: Selection) {
  selection = next;
  listeners.forEach((fn) => fn());
}
export function useSelection() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => selection,
  );
}
export const getSelection = () => selection;

export function addToSelection(files: PickedDraftFile[], folders: PickedFolder[] = []) {
  const { items } = normalizeSelection(
    files,
    folders,
    selection.items.map((item) => item.name),
  );
  set({ ...selection, items: [...selection.items, ...items] });
}
export function removeFromSelection(key: string) {
  set({ ...selection, items: selection.items.filter((item) => item.key !== key) });
}
export function setSelectionText(text: string) {
  set({ ...selection, text });
}
export function restoreSelection(previous: Selection) {
  set(previous);
}
export function clearSelection() {
  set({ items: [], text: "" });
}
