import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { api, urls } from "../shared/api.ts";
import { ApiError, Client, member, openShare, patchUpload, start } from "./support/harness.ts";

const rejectsStatus = (promise: Promise<unknown>, status: number) =>
  assert.rejects(promise, (error: unknown) => error instanceof ApiError && error.status === status);

function inspectZip(bytes: Buffer) {
  const script = `
import io, json, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    print(json.dumps({
        "bad": archive.testzip(),
        "entries": [[entry.filename, entry.is_dir(), entry.file_size] for entry in archive.infolist()],
    }))`;
  return JSON.parse(execFileSync("python3", ["-c", script], { input: bytes }).toString()) as {
    bad: string | null;
    entries: [string, boolean, number][];
  };
}

test("an empty folder can be saved, shared as a public ZIP, and accepted on another device", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "folderowner");
    const created = await owner.call(api.transfers.create, {
      body: { id: crypto.randomUUID(), tab: owner.tab, name: null, folders: ["Empty"], files: [] },
    });
    assert.deepEqual(created.uploads, []);
    const saved = await owner.call(api.transfers.complete, {
      params: { id: created.id },
      body: { destination: { kind: "save" } },
    });
    const item = await owner.call(api.items.get, { params: { id: saved.itemId } });
    assert.equal(item.files, 0);
    assert.equal(item.texts, 0);
    assert.equal(item.topFolders, 1);
    assert.equal(item.uploading, false);
    assert.deepEqual(
      item.nodes.map((node) => [node.kind, node.path]),
      [["folder", "Empty"]],
    );
    const expectedZip = { bad: null, entries: [["Empty/", true, 0]] };
    const ownerZip = await owner.raw({ method: "GET", url: urls.itemZip(item.id) });
    assert.equal(ownerZip.statusCode, 200);
    assert.deepEqual(inspectZip(ownerZip.rawPayload), expectedZip);

    const stranger = await member(instance, "folderstranger");
    await rejectsStatus(
      stranger.call(api.links.create, { body: { id: crypto.randomUUID(), item: item.id, days: 1 } }),
      404,
    );
    assert.equal((await stranger.raw({ method: "GET", url: urls.itemZip(item.id) })).statusCode, 404);
    const visitor = new Client(instance);
    assert.equal((await visitor.raw({ method: "GET", url: urls.itemZip(item.id) })).statusCode, 401);

    const link = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: item.id, days: 1 },
    });
    const opened = await openShare(visitor, link.token);
    assert.deepEqual(
      opened.nodes.map((node) => [node.kind, node.path]),
      [["folder", "Empty"]],
    );
    const publicZip = await visitor.raw({ method: "GET", url: urls.shareZip(link.token) });
    assert.equal(publicZip.statusCode, 200);
    assert.equal(publicZip.headers["content-type"], "application/zip");
    assert.deepEqual(inspectZip(publicZip.rawPayload), expectedZip);
    assert.equal((await visitor.raw({ method: "GET", url: urls.shareZip("invalid-token") })).statusCode, 404);

    const phone = new Client(instance);
    const phoneMe = await phone.signIn("folderowner", "Member-password-only", "Phone");
    const base = await instance.app.listen({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      const cookie = [...phone.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
      const req = request(base + urls.events(phone.tab), { agent: false, headers: { cookie } }, (res) => {
        res.once("data", () => resolve());
        res.resume();
      });
      req.on("error", reject);
      req.end();
    });
    const delivery = await owner.call(api.deliveries.create, {
      body: { id: crypto.randomUUID(), item: item.id, device: phoneMe.device.id },
    });
    assert.equal(delivery.state, "available");
    assert.equal(delivery.item?.topFolders, 1);
    await rejectsStatus(
      owner.call(api.deliveries.update, { params: { id: delivery.id }, body: { state: "accepted" } }),
      404,
    );
    assert.deepEqual(
      await phone.call(api.deliveries.update, { params: { id: delivery.id }, body: { state: "accepted" } }),
      { state: "accepted", changed: true },
    );
    const receivedZip = await phone.raw({ method: "GET", url: urls.itemZip(item.id) });
    assert.equal(receivedZip.statusCode, 200);
    assert.deepEqual(inspectZip(receivedZip.rawPayload), expectedZip);

    await owner.call(api.links.revoke, { params: { id: link.id } });
    assert.equal((await visitor.raw({ method: "GET", url: urls.shareZip(link.token) })).statusCode, 404);
    assert.equal((await owner.call(api.items.get, { params: { id: item.id } })).topFolders, 1);
  } finally {
    await instance.close();
  }
});

test("a ready folder does not allow sharing while another file is still uploading", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "folderpending");
    const created = await owner.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: owner.tab,
        name: null,
        folders: ["Empty"],
        files: [{ path: "later.txt", size: 5, mime: "text/plain" }],
      },
    });
    const body = { id: crypto.randomUUID(), item: created.itemId, days: 1 };
    await assert.rejects(
      owner.call(api.links.create, { body }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 409 &&
        error.message === "409 Wait for the uploads to finish before sharing.",
    );
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM links"), 0);
    assert.equal((await patchUpload(owner, created.uploads[0].id, 0, Buffer.from("later"))).statusCode, 204);
    await owner.call(api.transfers.complete, {
      params: { id: created.id },
      body: { destination: { kind: "save" } },
    });
    const link = await owner.call(api.links.create, { body });
    assert.equal(link.item?.files, 1);
    assert.equal(link.item?.topFolders, 1);
  } finally {
    await instance.close();
  }
});
