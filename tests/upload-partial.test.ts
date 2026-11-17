// A connection that drops partway through an upload request keeps the bytes that arrived, so the
// phone resends only the rest instead of the whole chunk again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { request, type ClientRequest } from "node:http";
import { api, headers, urls } from "../shared/api.ts";
import { member, patchUpload, start, type Client, type Instance } from "./support/harness.ts";
import { eventually, listen } from "./support/event-stream.ts";

const MB = 1024 ** 2;
const data = Buffer.from(Array.from({ length: 6 * MB }, (_, i) => (i * 7) % 251));

/** A PATCH whose body is still being sent: write some of it, then drop or keep it. */
function openPatch(base: string, client: Client, upload: string, offset: number, length: number) {
  const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const req: ClientRequest = request(base + urls.upload(upload), {
    method: "PATCH",
    agent: false,
    headers: {
      host: "relay.test",
      cookie,
      "x-relay-csrf": client.csrf,
      [headers.tab]: client.tab,
      "tus-resumable": "1.0.0",
      "upload-offset": String(offset),
      "content-type": "application/offset+octet-stream",
      "content-length": String(length),
    },
  });
  req.on("error", () => {});
  req.flushHeaders();
  return req;
}

async function startUpload(instance: Instance, client: Client) {
  const created = await client.call(api.transfers.create, {
    body: {
      id: crypto.randomUUID(),
      tab: client.tab,
      name: null,
      folders: [],
      files: [{ path: "video.bin", size: data.length, mime: "" }],
    },
  });
  return { created, upload: created.uploads[0].id };
}

const offsetOf = (instance: Instance, upload: string) =>
  instance.ctx.db.value<number>("SELECT offset FROM uploads WHERE id = ?", upload) ?? 0;
const partSize = (instance: Instance, upload: string) => {
  try {
    return statSync(join(instance.root, "uploads", `${upload}.part`)).size;
  } catch {
    return 0;
  }
};

test("bytes that arrived before the connection dropped are kept", async () => {
  const instance = await start();
  try {
    const base = await listen(instance);
    const client = await member(instance, "wes");
    const { created, upload } = await startUpload(instance, client);

    const req = openPatch(base, client, upload, 0, 4 * MB);
    req.write(data.subarray(0, 3 * MB));
    await eventually(() => partSize(instance, upload) >= 3 * MB, 5000);
    req.destroy(); // The phone's Wi-Fi dropped.
    await eventually(() => offsetOf(instance, upload) > 0, 5000);
    assert.equal(offsetOf(instance, upload), 3 * MB);

    // Resending starts where the server's bytes end, and the file comes out whole.
    const rest = await patchUpload(client, upload, 3 * MB, data.subarray(3 * MB));
    assert.equal(rest.statusCode, 204, rest.body);
    await client.call(api.transfers.complete, { params: { id: created.id }, body: { destination: { kind: "save" } } });
    const blob = instance.ctx.db.value<string>(
      "SELECT blob FROM nodes WHERE item = ? AND name = 'video.bin'",
      created.itemId,
    );
    assert.equal(blob, createHash("sha256").update(data).digest("hex"));
  } finally {
    await instance.close();
  }
});

test("a retry that replaces a stuck request learns where the server's bytes end", async () => {
  const instance = await start();
  try {
    const base = await listen(instance);
    const client = await member(instance, "xia");
    const { created, upload } = await startUpload(instance, client);

    // The first request is stuck (a phone that slept); its connection never says it closed.
    const stuck = openPatch(base, client, upload, 0, 4 * MB);
    stuck.write(data.subarray(0, 2 * MB));
    await eventually(() => partSize(instance, upload) >= 2 * MB, 5000);

    // The woken page retries from the offset it last knew; the server reports what it holds now.
    const retry = await patchUpload(client, upload, 0, data.subarray(0, 4 * MB));
    assert.equal(retry.statusCode, 409);
    assert.equal(retry.headers["upload-offset"], String(2 * MB));
    stuck.destroy();
    const rest = await patchUpload(client, upload, 2 * MB, data.subarray(2 * MB));
    assert.equal(rest.statusCode, 204, rest.body);
    await client.call(api.transfers.complete, { params: { id: created.id }, body: { destination: { kind: "save" } } });
    const blob = instance.ctx.db.value<string>(
      "SELECT blob FROM nodes WHERE item = ? AND name = 'video.bin'",
      created.itemId,
    );
    assert.equal(blob, createHash("sha256").update(data).digest("hex"));
  } finally {
    await instance.close();
  }
});

test("a cancelled upload's partial request is not kept", async () => {
  const instance = await start();
  try {
    const base = await listen(instance);
    const client = await member(instance, "yan");
    const { created, upload } = await startUpload(instance, client);
    const req = openPatch(base, client, upload, 0, 4 * MB);
    req.write(data.subarray(0, 2 * MB));
    await eventually(() => partSize(instance, upload) >= 2 * MB, 5000);
    await client.call(api.transfers.cancel, { params: { id: created.id } });
    req.destroy();
    await eventually(() => partSize(instance, upload) === 0, 5000);
    // Nothing of it was kept: no transfer, no upload, no part file.
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM uploads WHERE id = ?", upload), 0);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM transfers WHERE id = ?", created.id), 0);
  } finally {
    await instance.close();
  }
});
