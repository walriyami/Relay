// Uploads an earlier page left paused (it reloaded, closed, or its phone slept and another page
// asked), offered on the Send page so choosing the same files again finishes them.
import { useEffect, useSyncExternalStore } from "react";
import type { PausedTransfer } from "../../shared/model";
import { api, call } from "../api";
import { continuePaused, previousPageClosed, pruneDestinations } from "./transfers";

let list: PausedTransfer[] = [];
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((fn) => fn());
};

/** Asks the server once per page load which of the member's uploads are paused. */
function load() {
  return (loaded ??= (async () => {
    await previousPageClosed;
    try {
      list = await call(api.transfers.paused);
      pruneDestinations(list.map((p) => p.id));
    } catch {
      // Nothing to offer; the uploads stay paused until they are removed.
      list = [];
    }
    emit();
  })());
}

/** The member's paused uploads; empty until known. */
export function usePaused() {
  useEffect(() => void load(), []);
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
  );
  return list;
}

function drop(id: string) {
  list = list.filter((p) => p.id !== id);
  emit();
}

/** Stops a paused upload for good: what finished stays in Files, the rest is removed. */
export async function discardPaused(p: PausedTransfer) {
  await call(api.transfers.cancel, { params: { id: p.id } });
  pruneDestinations(list.filter((x) => x.id !== p.id).map((x) => x.id));
  drop(p.id);
}

export type Match = {
  /** The chosen file for each unfinished upload that has one. */
  chosen: Map<string, File>;
  /** Unfinished files nothing chosen matched. */
  missing: PausedTransfer["files"];
  /** Of those, the ones a chosen file matched by name and size but not by content. */
  different: string[];
};

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const relative = (file: File) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;

async function sameBytes(file: File, at: number, expected: string) {
  const want = Uint8Array.from(atob(expected), (c) => c.charCodeAt(0));
  const have = new Uint8Array(await file.slice(at, at + want.length).arrayBuffer());
  return have.length === want.length && have.every((b, i) => b === want[i]);
}

/**
 * Pairs the files just chosen with a paused upload's unfinished ones. A file must have the same size,
 * preferably the same path (or else the same name); where the server already holds some of it, its
 * first and last held bytes must also match, so a different file is never stitched onto it.
 * `earlier` keeps what an earlier choice matched.
 */
export async function match(p: PausedTransfer, files: File[], earlier?: Map<string, File>): Promise<Match> {
  const chosen = new Map(earlier);
  const used = new Set(chosen.values());
  const different: string[] = [];
  for (const target of p.files) {
    if (target.done || chosen.has(target.upload)) continue;
    const candidates = files.filter((f) => !used.has(f) && f.size === target.size);
    const ranked = [
      ...candidates.filter((f) => relative(f) === target.path || target.path.endsWith(`/${relative(f)}`)),
      ...candidates.filter((f) => f.name === baseName(target.path)),
    ];
    let found: File | undefined;
    for (const file of new Set(ranked)) {
      const sample = target.sample;
      if (
        target.offset > 0 &&
        (!sample ||
          !(await sameBytes(file, 0, sample.head)) ||
          !(await sameBytes(file, target.offset - atob(sample.tail).length, sample.tail)))
      )
        continue;
      found = file;
      break;
    }
    if (found) {
      chosen.set(target.upload, found);
      used.add(found);
    } else if (ranked.length) different.push(baseName(target.path));
  }
  const missing = p.files.filter((f) => !f.done && !chosen.has(f.upload));
  return { chosen, missing, different };
}

/** Continues a paused upload in this page and stops offering it. */
export async function continueUpload(p: PausedTransfer, chosen: Map<string, File>, skip: string[] = []) {
  const t = await continuePaused(p, chosen, skip);
  drop(p.id);
  return t;
}
