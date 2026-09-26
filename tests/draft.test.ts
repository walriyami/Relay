import assert from "node:assert/strict";
import test from "node:test";
import { addSelection, clearDraft, draftFiles, getDraft, removeItem, setText } from "../client/lib/draft.ts";
import { pathKey } from "../client/lib/path-key.ts";

const textFile = (name: string, contents = "x") => new File([contents], name, { lastModified: 1 });

test("identical file picks get separate stable rows and collision-free paths", () => {
  clearDraft();
  const file = textFile("same.txt");
  assert.deepEqual(
    addSelection([
      { file, path: file.name },
      { file, path: file.name },
    ]),
    { added: 2 },
  );

  const items = getDraft().items;
  assert.deepEqual(
    items.map((item) => item.name),
    ["same.txt", "same (2).txt"],
  );
  assert.notEqual(items[0].key, items[1].key);
  removeItem(items[0].key);
  assert.deepEqual(
    getDraft().items.map((item) => item.name),
    ["same (2).txt"],
  );
});

test("repeated identical folder paths in one selection become independent folders", () => {
  clearDraft();
  const one = textFile("one.txt", "one");
  const two = textFile("two.txt", "two");
  addSelection([
    { file: one, path: "Album/one.txt" },
    { file: two, path: "Album/inner/two.txt" },
    { file: one, path: "Album/one.txt" },
    { file: two, path: "Album/inner/two.txt" },
  ]);

  const folders = getDraft().items.filter((item) => item.kind === "folder");
  assert.deepEqual(
    folders.map((item) => item.name),
    ["Album", "Album (2)"],
  );
  assert.deepEqual(
    draftFiles(getDraft().items).files.map(({ path }) => path),
    ["Album/one.txt", "Album/inner/two.txt", "Album (2)/one.txt", "Album (2)/inner/two.txt"],
  );
  assert.deepEqual(draftFiles(getDraft().items).folders, ["Album", "Album/inner", "Album (2)", "Album (2)/inner"]);
});

test("dropped roots with the same name keep their own disjoint trees", () => {
  clearDraft();
  const left = textFile("left.txt");
  const right = textFile("right.txt");
  addSelection(
    [
      { file: left, path: "Album/left/left.txt", selectionId: "root-1" },
      { file: right, path: "Album/right/right.txt", selectionId: "root-2" },
    ],
    [
      { path: "Album", selectionId: "root-1" },
      { path: "Album/left", selectionId: "root-1" },
      { path: "Album", selectionId: "root-2" },
      { path: "Album/right", selectionId: "root-2" },
    ],
  );

  assert.deepEqual(
    getDraft().items.map((item) => item.name),
    ["Album", "Album (2)"],
  );
  const { files, folders } = draftFiles(getDraft().items);
  assert.deepEqual(
    files.map(({ path }) => path),
    ["Album/left/left.txt", "Album (2)/right/right.txt"],
  );
  assert.deepEqual(folders, ["Album", "Album/left", "Album (2)", "Album (2)/right"]);
});

test("case and Unicode path collisions are renamed without merging folder contents", () => {
  clearDraft();
  const composed = textFile("one.txt");
  const decomposed = textFile("two.txt");
  const loose = textFile("Root");
  addSelection(
    [
      { file: loose, path: "Root" },
      { file: composed, path: "root/Dir/one.txt" },
      { file: decomposed, path: "root/dir/two.txt" },
      { file: composed, path: "root/é/one.txt" },
      { file: decomposed, path: "root/e\u0301/two.txt" },
    ],
    ["root/Dir", "root/dir", "root/é", "root/e\u0301"],
  );

  const { files, folders } = draftFiles(getDraft().items);
  assert.equal(getDraft().items[0].name, "Root");
  assert.equal(getDraft().items[1].name, "root (2)");
  assert.deepEqual(
    files.map(({ path }) => path),
    ["Root", "root (2)/Dir/one.txt", "root (2)/dir (2)/two.txt", "root (2)/é/one.txt", "root (2)/é (2)/two.txt"],
  );
  assert.deepEqual(folders, ["root (2)", "root (2)/Dir", "root (2)/dir (2)", "root (2)/é", "root (2)/é (2)"]);
  setText("one message for the repeated picks");
  assert.equal(getDraft().text, "one message for the repeated picks");
});

test("collision suffixes fit server name limits while keeping multibyte stems and extensions", () => {
  clearDraft();
  const name = `${"界".repeat(69)}${"a".repeat(44)}.txt`;
  const file = textFile(name);
  addSelection([
    { file, path: name },
    { file, path: name },
  ]);

  const names = getDraft().items.map((item) => item.name);
  assert.equal(names[0], name);
  assert.ok(names[1].endsWith(" (2).txt"));
  for (const candidate of names) {
    assert.ok(candidate.length <= 180);
    assert.ok(new TextEncoder().encode(candidate).length <= 255);
  }
});

test("path identity matches NFC and the server's ASCII case rule", () => {
  assert.equal(pathKey("A\u030a.txt"), pathKey("Å.txt"));
  assert.notEqual(pathKey("ẞ.txt"), pathKey("ß.txt"));
  assert.deepEqual([pathKey("ẞ.txt"), pathKey("ß.txt")], ["ẞ.txt", "ß.txt"]);
});
