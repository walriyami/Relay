import assert from "node:assert/strict";
import test from "node:test";
import { collectDroppedSelection } from "../client/drop-selection.ts";
import { addSelection, clearDraft, draftFiles, getDraft } from "../client/lib/draft.ts";

function fileEntry(file: File) {
  return {
    name: file.name,
    isFile: true,
    isDirectory: false,
    file(success: (file: File) => void) {
      success(file);
    },
  } as unknown as FileSystemFileEntry;
}

function directoryEntry(name: string, children: FileSystemEntry[]) {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let read = false;
      return {
        readEntries(success: (entries: FileSystemEntry[]) => void) {
          if (read) success([]);
          else {
            read = true;
            success(children);
          }
        },
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

test("dropped folders with the same root keep separate identities and hierarchies", async () => {
  clearDraft();
  const first = directoryEntry("Album", [fileEntry(new File(["one"], "one.txt"))]);
  const second = directoryEntry("Album", [fileEntry(new File(["two"], "two.txt"))]);
  const items = [first, second].map(
    (entry) =>
      ({
        webkitGetAsEntry: () => entry,
        getAsFile: () => null,
      }) as unknown as DataTransferItem,
  );
  const list = items as unknown as DataTransferItemList;

  const selection = await collectDroppedSelection(list);
  assert.deepEqual(
    selection.files.map(({ path }) => path),
    ["Album/one.txt", "Album/two.txt"],
  );
  assert.notEqual(selection.files[0].selectionId, selection.files[1].selectionId);
  assert.deepEqual(
    selection.folders.map(({ path }) => path),
    ["Album", "Album"],
  );

  addSelection(selection.files, selection.folders);
  assert.deepEqual(
    getDraft().items.map((item) => item.name),
    ["Album", "Album (2)"],
  );
  assert.deepEqual(
    draftFiles(getDraft().items).files.map(({ path }) => path),
    ["Album/one.txt", "Album (2)/two.txt"],
  );
});

test("a dropped file is taken as given, even when its entry can't be read back", async () => {
  const file = new File(["hello"], "notes.txt");
  const unreadable = {
    name: file.name,
    isFile: true,
    isDirectory: false,
    file(_success: (file: File) => void, failure: (error: Error) => void) {
      failure(new Error("NotFoundError"));
    },
  } as unknown as FileSystemFileEntry;
  const list = [{ webkitGetAsEntry: () => unreadable, getAsFile: () => file }] as unknown as DataTransferItemList;

  const selection = await collectDroppedSelection(list);
  assert.deepEqual(
    selection.files.map(({ file, path }) => [file, path]),
    [[file, "notes.txt"]],
  );
  assert.equal(selection.skipped, 0);
});

test("a folder walk reads entries concurrently, within a bound, in a one-by-one walk's order", async () => {
  let active = 0;
  let peak = 0;
  // Each read finishes after a delay that shrinks along the list, so completion order is reversed.
  const slow = <T>(value: T, delay: number, fail = false) =>
    new Promise<T>((resolve, reject) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        if (fail) reject(new Error("unreadable"));
        else resolve(value);
      }, delay);
    });
  let delay = 60;
  const file = (name: string, fail = false) => {
    const wait = Math.max(1, delay--);
    return {
      name,
      isFile: true,
      isDirectory: false,
      file: (ok: (f: File) => void, no: (e: unknown) => void) =>
        void slow(new File([name], name), wait, fail).then(ok, no),
    } as unknown as FileSystemFileEntry;
  };
  const folder = (name: string, children: FileSystemEntry[]) =>
    ({
      name,
      isFile: false,
      isDirectory: true,
      createReader() {
        // Browsers hand entries over in batches; two here.
        const batches = [children.slice(0, 20), children.slice(20), []];
        return {
          readEntries: (ok: (e: FileSystemEntry[]) => void, no: (e: unknown) => void) =>
            void slow(batches.shift() ?? [], 1).then(ok, no),
        };
      },
    }) as unknown as FileSystemDirectoryEntry;
  const inner = folder(
    "inner",
    Array.from({ length: 5 }, (_, i) => file(`n${i}.txt`)),
  );
  const root = folder("root", [
    ...Array.from({ length: 30 }, (_, i) => file(`f${String(i).padStart(2, "0")}.txt`, i === 7)),
    inner,
    file("last.txt"),
  ]);
  const list = [{ webkitGetAsEntry: () => root, getAsFile: () => null }] as unknown as DataTransferItemList;
  const selection = await collectDroppedSelection(list);
  const expected = [
    ...Array.from({ length: 30 }, (_, i) => `root/f${String(i).padStart(2, "0")}.txt`).filter(
      (p) => p !== "root/f07.txt",
    ),
    ...Array.from({ length: 5 }, (_, i) => `root/inner/n${i}.txt`),
    "root/last.txt",
  ];
  assert.deepEqual(
    selection.files.map((f) => f.path),
    expected,
  );
  assert.deepEqual(
    selection.folders.map((f) => f.path),
    ["root", "root/inner"],
  );
  assert.equal(selection.skipped, 1);
  assert.ok(peak > 1, "entries are read concurrently");
  assert.ok(peak <= 16, `at most 16 reads at once, saw ${peak}`);
});
