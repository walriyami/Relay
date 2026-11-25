// Taking access away stops a download already running, not only new ones: turning a link off,
// signing a device out, suspending a member, or deleting an item forever.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import { api, urls } from "../shared/api.ts";
import { RECHECK_MS } from "../server/modules/downloads/serve.ts";
import { admin, Client, member, openShare, send, start, type Instance } from "./support/harness.ts";

const FILE = 16 * 1024 * 1024;
let instance: Instance;
let base: string;
let owner: Client;
let itemId: string;

before(async () => {
  instance = await start();
  owner = await member(instance, "keeper");
  ({
    result: { itemId },
  } = await send(owner, [
    { path: "a.bin", data: randomBytes(FILE) },
    { path: "b.bin", data: randomBytes(FILE) },
  ]));
  base = await instance.app.listen({ port: 0, host: "127.0.0.1" });
});
// A failed check can leave a download open, which would hold the server open with it.
const started: IncomingMessage[] = [];
after(async () => {
  for (const res of started) res.destroy();
  await instance.close();
});

/** Starts a GET over a real socket and resolves once the first bytes arrive, with the rest held back. */
function begin(url: string, client: Client, headers: Record<string, string> = {}) {
  const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const host = new URL(instance.ctx.config.origin ?? "http://localhost").host;
  return new Promise<{ res: IncomingMessage; first: number; length: number }>((resolve, reject) => {
    const req = request(base + url, { agent: false, headers: { cookie, host, ...headers } }, (res) => {
      started.push(res);
      res.once("data", (chunk: Buffer) => {
        res.pause();
        resolve({ res, first: chunk.length, length: Number(res.headers["content-length"]) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Reads the rest at once: how many more bytes came, and whether the body reached its Content-Length. */
function finish(res: IncomingMessage) {
  return new Promise<{ bytes: number; complete: boolean }>((resolve) => {
    let bytes = 0;
    res.on("data", (chunk: Buffer) => (bytes += chunk.length));
    res.on("error", () => {});
    res.on("close", () => resolve({ bytes, complete: res.complete }));
    res.resume();
  });
}

const newLink = () => owner.call(api.links.create, { body: { id: crypto.randomUUID(), item: itemId, days: 7 } });

test("a download nobody takes access from finishes, however long it waits", async () => {
  const link = await newLink();
  const visitor = new Client(instance);
  await openShare(visitor, link.token);
  const { res, first, length } = await begin(urls.shareZip(link.token), visitor);
  assert.ok(length > 2 * FILE);
  // A reader that stops for a while is asked again when it carries on, and still may.
  await new Promise((resolve) => setTimeout(resolve, RECHECK_MS + 100));
  const rest = await finish(res);
  assert.ok(rest.complete);
  assert.equal(first + rest.bytes, length);
});

test("turning a link off stops its downloads already running", async () => {
  const link = await newLink();
  const visitor = new Client(instance);
  const share = await openShare(visitor, link.token);
  const zip = await begin(urls.shareZip(link.token), visitor);
  const node = share.nodes.find((n) => n.kind === "file")!;
  const file = await begin(urls.shareContent(link.token, node.id), visitor, { range: "bytes=0-" });
  await owner.call(api.links.revoke, { params: { id: link.id } });
  for (const { res, first, length } of [zip, file]) {
    const rest = await finish(res);
    assert.ok(!rest.complete, "cut short");
    assert.ok(first + rest.bytes < length);
  }
});

test("a file download is cut short even when its link is turned off the moment it starts", async () => {
  const link = await newLink();
  const visitor = new Client(instance);
  const share = await openShare(visitor, link.token);
  const node = share.nodes.find((n) => n.kind === "file")!;
  const { res, first, length } = await begin(urls.shareContent(link.token, node.id), visitor);
  // As the owner's request would, but without its own time: within a few milliseconds of the start.
  instance.ctx.db.run("UPDATE links SET revoked = ? WHERE id = ?", Date.now(), link.id);
  const rest = await finish(res);
  assert.ok(!rest.complete, "cut short");
  assert.ok(first + rest.bytes < length, `${first + rest.bytes} bytes of ${length}`);
});

test("a password put on a link stops the downloads of people who never entered it", async () => {
  const link = await newLink();
  const visitor = new Client(instance);
  await openShare(visitor, link.token);
  const { res, first, length } = await begin(urls.shareZip(link.token), visitor);
  await owner.call(api.links.update, { params: { id: link.id }, body: { password: "A-new-password-1" } });
  const rest = await finish(res);
  assert.ok(!rest.complete, "cut short");
  assert.ok(first + rest.bytes < length);
});

test("a running share download asks again without letting the visitor in again each time", async (t) => {
  const link = await newLink();
  const visitor = new Client(instance);
  await openShare(visitor, link.token);
  const content = t.mock.method(instance.ctx.links, "content");
  const still = t.mock.method(instance.ctx.links, "still");
  const { res, length } = await begin(urls.shareZip(link.token), visitor);
  const rest = await finish(res);
  assert.ok(rest.complete);
  assert.ok(length > 32 * 1024 * 1024);
  // Once for the request and once just before its bytes go; every later check is the light one.
  assert.ok(content.mock.callCount() <= 2, `${content.mock.callCount()} full checks`);
  assert.ok(still.mock.callCount() >= 2, `${still.mock.callCount()} light checks`);
});

test("signing a device out stops its downloads already running, the export of everything too", async () => {
  const device = new Client(instance);
  await device.signIn("keeper", "Member-password-only");
  const node = (await device.call(api.items.get, { params: { id: itemId } })).nodes.find((n) => n.kind === "file")!;
  const downloads = [
    await begin(urls.nodeContent(node.id), device),
    await begin(urls.itemZip(itemId), device),
    await begin(urls.exportZip(), device),
  ];
  await device.call(api.session.signOut);
  for (const { res, first, length } of downloads) {
    const rest = await finish(res);
    assert.ok(!rest.complete, "cut short");
    assert.ok(first + rest.bytes < length);
  }
});

test("suspending a member stops their downloads already running", async () => {
  const adminClient = await admin(instance);
  const lender = await member(instance, "lender", adminClient);
  const { result } = await send(lender, [
    { path: "c.bin", data: randomBytes(FILE) },
    { path: "d.bin", data: randomBytes(FILE) },
  ]);
  const { res, first, length } = await begin(urls.itemZip(result.itemId), lender);
  const id = instance.ctx.db.value<string>("SELECT id FROM users WHERE username = 'lender'")!;
  await adminClient.call(api.admin.updateMember, { params: { id }, body: { disabled: true } });
  const rest = await finish(res);
  assert.ok(!rest.complete, "cut short");
  assert.ok(first + rest.bytes < length);
});

// Last: it deletes the item the others download.
test("deleting an item forever stops its ZIP promptly, not after the file already open", async () => {
  const link = await newLink();
  const visitor = new Client(instance);
  await openShare(visitor, link.token);
  const { res, first, length } = await begin(urls.shareZip(link.token), visitor);
  await owner.call(api.items.trash, { params: { id: itemId } });
  await owner.call(api.items.remove, { params: { id: itemId } });
  const rest = await finish(res);
  assert.ok(!rest.complete, "the archive fails rather than looking whole");
  // What was on its way already, and at most a megabyte more: not the rest of the first file.
  assert.ok(first + rest.bytes < FILE, `${first + rest.bytes} bytes of ${length}`);
});
