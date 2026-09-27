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
