import { test } from "node:test";
import assert from "node:assert/strict";
import { api, urls } from "../shared/api.ts";
import { cleanFileName, fileNameHides, shownText } from "../shared/text.ts";
import { cleanPath } from "../client/lib/nearby/protocol.ts";
import { ApiError, Client, member, send, start } from "./support/harness.ts";

// Names that show something other than what they are: the real ending pushed out of sight by wide
// spaces, blank-looking fillers, a zero-width space, a direction override, or nothing visible.
const HIDING = [
  `invoice.pdf${" ".repeat(40)}.exe`,
  `invoice.pdf${" ".repeat(4)}.exe`,
  "invoice.pdfㅤㅤ.exe",
  "photoᅟ.jpg",
  "a⠀b.txt",
  "a​b.txt",
  "photo‮gpj.exe",
  "photo‏.jpg",
  "​ㅤ",
];
// Real names: a few spaces, right-to-left writing, a Persian non-joiner, a joined emoji.
const REAL = [
  "My  notes   (final).txt",
  "ملف العمل.pdf",
  "نا‌مه.txt",
  "\u{1F468}‍\u{1F469}‍\u{1F467}.png",
  "דוח 2024.docx",
];

const status = (promise: Promise<unknown>) =>
  promise.then(
    () => 200,
    (e: unknown) => {
      if (e instanceof ApiError) return e.status;
      throw e;
    },
  );

test("a file name can't hide its real ending, and names from elsewhere are cleaned rather than refused", () => {
  for (const name of HIDING) assert.equal(fileNameHides(name), true, JSON.stringify(name));
  for (const name of REAL) assert.equal(fileNameHides(name), false, name);
  assert.equal(cleanFileName(`invoice.pdf${" ".repeat(40)}.exe`), "invoice.pdf .exe");
  assert.equal(cleanFileName("photo‮gpj.exe"), "photogpj.exe");
  assert.equal(cleanFileName("​ㅤ "), "");
  for (const name of REAL) assert.equal(cleanFileName(name), name.normalize("NFC"));
  // Received over Nearby: every part of the path, and nothing that climbs out of it.
  assert.equal(cleanPath("Trip‮/photo‮gpj.exe"), "Trip/photogpj.exe");
  assert.equal(cleanPath("../ㅤ/a    b.txt"), "a b.txt");
  // Shown to people: direction overrides stored before they were refused are left out.
  assert.equal(shownText("Sara‮ evil‬ ok"), "Sara evil ok");
  assert.equal(shownText("שלום‏!"), "שלום‏!");
});

test("every way a name reaches Relay refuses one that hides what it is", async () => {
  const instance = await start();
  try {
    const sara = await member(instance, "sara");
    for (const name of HIDING) {
      // A file, a folder in its path, an empty folder and the item's own name.
      assert.equal(await status(send(sara, [{ path: name, data: "x" }])), 400, JSON.stringify(name));
      assert.equal(await status(send(sara, [{ path: `${name}/a.txt`, data: "x" }])), 400, JSON.stringify(name));
      assert.equal(await status(send(sara, [{ path: "a.txt", data: "x" }], { name })), 400, JSON.stringify(name));
      // Text alone, named.
      assert.equal(await status(send(sara, [], { text: "hello", name })), 400, JSON.stringify(name));
    }
    const { result } = await send(sara, [{ path: "a.txt", data: "x" }]);
    for (const name of HIDING)
      assert.equal(
        await status(sara.call(api.items.update, { params: { id: result.itemId }, body: { name } })),
        400,
        JSON.stringify(name),
      );
    // The error doesn't repeat the name back.
    const refused = await send(sara, [{ path: HIDING[2], data: "x" }]).catch((e: ApiError) => e);
    assert.ok(refused instanceof ApiError && !refused.message.includes("ㅤ"));

    for (const name of REAL) {
      const sent = await send(sara, [{ path: `${name}/${name}`, data: "x" }], { name });
      const item = await sara.call(api.items.get, { params: { id: sent.result.itemId } });
      assert.equal(item.name, name.normalize("NFC"));
      await sara.call(api.items.update, { params: { id: sent.result.itemId }, body: { name: `Re ${name}` } });
    }
  } finally {
    await instance.close();
  }
});

test("request links refuse hiding names from visitors, and still name what they send", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "xena");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Tax papers", description: "", days: 5, maxBytes: 1000 },
    });
    const visitor = new Client(instance);
    await visitor.call(api.requests.start, { params: { token: request.token } });
    const transfer = (path: string, sender?: string) =>
      visitor.call(api.requests.transfer, {
        params: { token: request.token },
        body: {
          id: crypto.randomUUID(),
          tab: visitor.tab,
          folders: [],
          files: [{ path, size: 1, mime: "text/plain" }],
          ...(sender ? { sender } : {}),
        },
      });
    assert.equal(await status(transfer(`scan.pdf${" ".repeat(10)}.exe`)), 400);
    assert.equal(await status(transfer("scan‮fdp.exe")), 400);

    // A request named before these rules, and a sender whose name has a filler in it: the item they
    // make is named without them rather than refused.
    instance.ctx.db.run("UPDATE requests SET name = ? WHERE id = ?", `Taxㅤㅤ${" ".repeat(8)}papers`, request.id);
    const created = await transfer("scan.pdf", "Boㅤb");
    const name = instance.ctx.db.value<string>("SELECT name FROM items WHERE id = ?", created.itemId);
    assert.ok(name && !fileNameHides(name), JSON.stringify(name));
    assert.match(name, /^Tax papers · Bob/);
  } finally {
    await instance.close();
  }
});

test("names stored before the rule still list, download under a clean name, and delete", async () => {
  const instance = await start();
  try {
    const sara = await member(instance, "sara");
    const { result } = await send(sara, [{ path: "invoice.pdf", data: "pdf" }]);
    const padded = `invoice.pdf${" ".repeat(30)}ㅤ.exe`;
    instance.ctx.db.run("UPDATE nodes SET name = ? WHERE item = ?", padded, result.itemId);
    const item = await sara.call(api.items.get, { params: { id: result.itemId } });
    assert.equal(item.nodes[0].name, padded);
    const res = await sara.raw({ method: "GET", url: urls.nodeContent(item.nodes[0].id) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-disposition"], "attachment; filename*=UTF-8''invoice.pdf%20.exe");
    await sara.call(api.items.trash, { params: { id: result.itemId } });
    await sara.call(api.items.remove, { params: { id: result.itemId } });
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM nodes WHERE item = ?", result.itemId), 0);
  } finally {
    await instance.close();
  }
});
