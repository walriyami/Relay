import { useSyncExternalStore } from "react";
import { LIMITS } from "../../shared/model.ts";
import { pathKey } from "./path-key.ts";
import type { DraftFile } from "./transfers";

// The composer's selection is a local draft. Nothing here touches the server.
export type DraftItem =
  | { kind: "file"; key: string; name: string; file: File; path: string; size: number }
  | {
      kind: "folder";
      key: string;
      name: string;
      files: DraftFile[];
      folders: string[];
      size: number;
    };
type Draft = { items: DraftItem[]; text: string };
export type PickedDraftFile = DraftFile & { selectionId?: string };
export type PickedFolder = string | { path: string; selectionId?: string };
export type SelectionRename = { itemKey: string; from: string; to: string; path: string };

// Typed text survives a reload of this tab (files can't); it is gone when the tab closes, and is
// cleared when it is sent or someone signs out.
const TEXT_KEY = "relay.draftText";
function savedText() {
  try {
    return sessionStorage.getItem(TEXT_KEY) ?? "";
  } catch {
    return "";
  }
}
let draft: Draft = { items: [], text: typeof window === "undefined" ? "" : savedText() };
const listeners = new Set<() => void>();
let nextIdentity = 0;
const identity = (kind: string) => `${kind}:${++nextIdentity}`;

function set(next: Draft) {
  if (next.text !== draft.text)
    try {
      if (next.text) sessionStorage.setItem(TEXT_KEY, next.text);
      else sessionStorage.removeItem(TEXT_KEY);
    } catch {
      // Storage can be unavailable (private modes); the draft then lives only in memory.
    }
  draft = next;
  listeners.forEach((fn) => fn());
}
export function useDraft() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => draft,
  );
}
export const getDraft = () => draft;
export function setText(text: string) {
  set({ ...draft, text });
}
export function removeItem(key: string) {
  set({ ...draft, items: draft.items.filter((i) => i.key !== key) });
}
export function clearDraft() {
  set({ items: [], text: "" });
}
/** Puts back a draft taken with getDraft(), for Undo. */
export function restoreDraft(previous: Draft) {
  set(previous);
}
export function clearItems() {
  set({ ...draft, items: [] });
}

const canonical = pathKey;
const splitFileName = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
};
const withinNameLimits = (name: string) =>
  name.length <= LIMITS.nameLength && new TextEncoder().encode(name).length <= 255;
const dropLastCodePoint = (value: string) => Array.from(value).slice(0, -1).join("");

/** Fit a source name and collision suffix inside the same limits enforced by cleanName on the server. */
function boundedName(name: string, suffix: string, file: boolean) {
  let normalized = name.trim().normalize("NFC");
  if (!normalized || normalized === "." || normalized === "..") normalized = file ? "File" : "Folder";
  let [stem, extension] = file ? splitFileName(normalized) : [normalized, ""];
  const compose = () => `${stem}${suffix}${extension}`;
  while (!withinNameLimits(compose()) && stem) stem = dropLastCodePoint(stem);
  while (!withinNameLimits(compose()) && extension) {
    const points = Array.from(extension);
    extension = points.length > 1 ? `.${points.slice(2).join("")}` : "";
  }
  normalized = compose();
  return normalized;
}

type FolderGroup = { root: string; files: PickedDraftFile[]; folders: string[] };
type DirectoryNames = { bySource: Map<string, string>; used: Set<string> };
const suffixIndexes = new WeakMap<Set<string>, Map<string, number>>();

/** Reserve a name against the filesystem's case-insensitive sibling rules. */
function uniqueSibling(name: string, used: Set<string>, file: boolean) {
  let candidate = boundedName(name, "", file);
  if (!used.has(canonical(candidate))) {
    used.add(canonical(candidate));
    return candidate;
  }
  const indexes = suffixIndexes.get(used) ?? new Map<string, number>();
  suffixIndexes.set(used, indexes);
  const suffixKey = `${file ? "file" : "folder"}:${canonical(candidate)}`;
  for (let n = indexes.get(suffixKey) ?? 2; ; n++) {
    candidate = boundedName(name, ` (${n})`, file);
    if (used.has(canonical(candidate))) continue;
    used.add(canonical(candidate));
    indexes.set(suffixKey, n + 1);
    return candidate;
  }
}

/**
 * Make every directory and file path in a selected folder unique without changing its hierarchy.
 * Directory siblings claim their names first, so a file that would otherwise become a directory
 * (or hide one) gets the predictable "(2)" suffix.
 */
function placeFolder(group: FolderGroup, name: string) {
  const sourceDirectories = new Map<string, string>();
  const directoryNames = new Map<string, DirectoryNames>();

  const addDirectory = (sourcePath: string) => {
    const parts = sourcePath.split("/");
    if (parts[0] !== group.root) return;
    let sourcePrefix = parts[0];
    let destPrefix = name;
    sourceDirectories.set(sourcePrefix, destPrefix);
    for (const sourcePart of parts.slice(1)) {
      sourcePrefix += `/${sourcePart}`;
      const sourceKey = sourcePrefix;
      const known = sourceDirectories.get(sourceKey);
      if (known) {
        destPrefix = known;
        continue;
      }
      const parentKey = canonical(destPrefix);
      const siblings = directoryNames.get(parentKey) ?? {
        bySource: new Map<string, string>(),
        used: new Set<string>(),
      };
      directoryNames.set(parentKey, siblings);
      const sameSource = siblings.bySource.get(sourcePart);
      // The same source path is one directory; a differently-cased path is a distinct source entry.
      const actualPart = sameSource ?? uniqueSibling(sourcePart, siblings.used, false);
      if (!sameSource) {
        siblings.bySource.set(sourcePart, actualPart);
      }
      destPrefix = `${destPrefix}/${actualPart}`;
      sourceDirectories.set(sourceKey, destPrefix);
    }
  };

  // Explicit empty directories and every implicit parent directory are retained.
  const explicit = [group.root, ...group.folders];
  for (const file of group.files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) explicit.push(parts.slice(0, i).join("/"));
  }
  for (const path of explicit) addDirectory(path);

  // Keep the selected root even when a folder has no files and the picker omitted its root entry.
  const mappedFolders = new Set<string>([name]);
  for (const path of group.folders) {
    const mapped = sourceDirectories.get(path);
    if (mapped) mappedFolders.add(mapped);
  }
  for (const path of explicit) {
    const mapped = sourceDirectories.get(path);
    if (mapped) mappedFolders.add(mapped);
  }

  const fileNames = new Map<string, Set<string>>();
  for (const [parent, children] of directoryNames) {
    fileNames.set(parent, new Set(children.used));
  }
  const renames: Omit<SelectionRename, "itemKey">[] = [];
  const files = group.files.map(({ file, path }) => {
    const parts = path.split("/");
    let sourceParent = parts[0];
    let destParent = name;
    for (let i = 1; i < parts.length - 1; i++) {
      sourceParent += `/${parts[i]}`;
      destParent = sourceDirectories.get(sourceParent) ?? destParent;
    }
    const parentKey = canonical(destParent);
    const siblings = fileNames.get(parentKey) ?? new Set<string>();
    fileNames.set(parentKey, siblings);
    const fileName = uniqueSibling(parts.at(-1) ?? "", siblings, true);
    const placedPath = `${destParent}/${fileName}`;
    if (path !== placedPath) renames.push({ from: path, to: placedPath, path });
    return { file, path: placedPath };
  });

  for (const path of group.folders) {
    const placed = sourceDirectories.get(path);
    if (placed && path !== placed) renames.push({ from: path, to: placed, path });
  }
  if (!group.files.length && !group.folders.length && group.root !== name)
    renames.push({ from: group.root, to: name, path: group.root });

  return { files, folders: [...mappedFolders], renames };
}

/** Build distinct, path-safe items without mutating the ambient Send draft. */
export function normalizeSelection(
  files: PickedDraftFile[],
  folders: PickedFolder[] = [],
  takenNames: Iterable<string> = [],
) {
  const items: DraftItem[] = [];
  const renames: SelectionRename[] = [];
  const taken = new Set(Array.from(takenNames, canonical));
  const groups = new Map<string, FolderGroup>();
  const fileOccurrences = new Map<string, Map<string, number>>();
  const folderOccurrences = new Map<string, Map<string, number>>();

  const groupFor = (path: string, selectionId?: string, isFolder = false) => {
    const slash = path.indexOf("/");
    const root = slash < 0 ? path : path.slice(0, slash);
    const rootKey = root;
    let instance = 0;
    if (selectionId === undefined) {
      const occurrenceMap = isFolder ? folderOccurrences : fileOccurrences;
      const occurrences = occurrenceMap.get(rootKey) ?? new Map<string, number>();
      occurrenceMap.set(rootKey, occurrences);
      const pathKey = path;
      instance = occurrences.get(pathKey) ?? 0;
      occurrences.set(pathKey, instance + 1);
    }
    const groupKey = selectionId === undefined ? `auto:${rootKey}:${instance}` : `pick:${selectionId}:${rootKey}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { root, files: [], folders: [] };
      groups.set(groupKey, group);
    }
    return group;
  };

  for (const f of files) {
    const slash = f.path.indexOf("/");
    if (slash < 0) {
      const name = uniqueSibling(f.path, taken, true);
      const key = identity("item");
      items.push({ kind: "file", key, name, file: f.file, path: name, size: f.file.size });
      if (f.path !== name) renames.push({ itemKey: key, from: f.path, to: name, path: f.path });
      continue;
    }
    groupFor(f.path, f.selectionId).files.push(f);
  }
  for (const folder of folders) {
    const path = typeof folder === "string" ? folder : folder.path;
    const selectionId = typeof folder === "string" ? undefined : folder.selectionId;
    groupFor(path, selectionId, true).folders.push(path);
  }

  for (const group of groups.values()) {
    const name = uniqueSibling(group.root, taken, false);
    const placed = placeFolder(group, name);
    const size = placed.files.reduce((n, f) => n + f.file.size, 0);
    const key = identity("item");
    items.push({
      kind: "folder",
      key,
      name,
      files: placed.files,
      folders: placed.folders,
      size,
    });
    renames.push(...placed.renames.map((rename) => ({ ...rename, itemKey: key })));
  }
  return { items, renames };
}

// Adds a selection. Every pick gets a fresh identity; colliding paths get readable unique names.
export function addSelection(files: PickedDraftFile[], folders: PickedFolder[] = []) {
  const normalized = normalizeSelection(
    files,
    folders,
    draft.items.map((item) => item.name),
  );
  set({ ...draft, items: [...draft.items, ...normalized.items] });
  return { added: normalized.items.length };
}

export function fromFileList(list: FileList | File[], folder = false): PickedDraftFile[] {
  return Array.from(list).map((file) => ({
    file,
    path: (folder && (file as File & { webkitRelativePath?: string }).webkitRelativePath) || file.name,
  }));
}

export function draftFiles(items: DraftItem[]) {
  const files: DraftFile[] = [];
  const folders: string[] = [];
  for (const item of items)
    if (item.kind === "file") files.push({ file: item.file, path: item.path });
    else {
      files.push(...item.files);
      folders.push(...item.folders);
    }
  return { files, folders };
}
