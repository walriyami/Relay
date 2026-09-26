// Turns a transfer manifest into the ordered list of nodes to create: folders mkdir -p style,
// parents before children, each file once. Paths compare the way SQLite's NOCASE does (ASCII
// letters only), so a conflict found here is exactly one the sibling-name index would reject.
import type { TransferInput } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { splitPath } from "../../lib/names.ts";

export type PlannedNode = {
  key: string;
  parentKey: string | null;
  name: string;
  /** The path as it will be stored: parents keep the spelling they were first given. */
  path: string;
  kind: "folder" | "file";
  /** Index into input.files for a file. */
  file?: number;
};

export const foldCase = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());

export function planNodes(input: Pick<TransferInput, "files" | "folders">): PlannedNode[] {
  const planned = new Map<string, PlannedNode>();

  const add = (segments: string[], kind: PlannedNode["kind"], file?: number): PlannedNode => {
    let parent: PlannedNode | null = null;
    for (let i = 0; i < segments.length; i++) {
      const last = i === segments.length - 1;
      const entryKind = last ? kind : "folder";
      const name = segments[i];
      const key = (parent ? parent.key + "/" : "") + foldCase(name);
      const path = (parent ? parent.path + "/" : "") + name;
      const existing = planned.get(key);
      if (existing) {
        if (existing.kind === "file" && entryKind === "file")
          fail(409, `Two files in this transfer have the path "${path}".`);
        if (existing.kind !== entryKind) fail(409, `"${existing.path}" is both a file and a folder in this transfer.`);
        parent = existing;
        continue;
      }
      const node: PlannedNode = { key, parentKey: parent?.key ?? null, name, path, kind: entryKind };
      if (last && file !== undefined) node.file = file;
      planned.set(key, node);
      parent = node;
    }
    return parent!;
  };

  // Files first, in request order, so the first thing picked is the first top-level node.
  input.files.forEach((f, index) => add(splitPath(f.path), "file", index));
  for (const folder of input.folders) add(splitPath(folder), "folder");
  return [...planned.values()];
}
