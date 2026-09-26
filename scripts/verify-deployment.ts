// Live smoke test of a deployed Relay over its public origin, using generated fixtures only:
// resumable upload after a dropped chunk, idempotent completion, owner downloads with ranges,
// previews and thumbnails, a share link opened by pickup code, the streaming ZIP (owner and share)
// with every payload hash and a Range-resumed download, sign-in with a login code on a second
// device that receives a delivery while online, authorization of anonymous callers, and link
// revocation. Generated items and sessions are cleaned up; device history remains.
//
// It never runs by accident and never defaults to any origin:
//   RELAY_VERIFY_USERNAME=... RELAY_VERIFY_PASSWORD=... \
//     npm run verify:deployment -- --run-live --origin https://relay.example.com [--size 72MiB]
// Plain http is accepted only for loopback origins (a disposable local instance).
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { api, urls } from "../shared/api.ts";
import { LIMITS, type Id, type Link } from "../shared/model.ts";
import {
  Session,
  assert,
  bufferSource,
  download,
  mib,
  parseSize,
  pdfFixture,
  readZip,
  resumedDownload,
  sendFiles,
  sha256,
  sleep,
  stalledPatch,
  stepper,
  upload,
  uploadOffset,
  errorStack,
  errorMessage,
} from "./lib/relay.ts";

const { values: flags } = parseArgs({
  options: {
    "run-live": { type: "boolean", default: false },
    origin: { type: "string" },
    size: { type: "string", default: "72MiB" },
  },
});
if (!flags["run-live"] || !flags.origin) {
  console.error(
    "Refusing to run: pass --run-live and --origin <https://...> explicitly, once the deployment is confirmed ready.",
  );
  process.exit(2);
}
const origin = new URL(flags.origin).origin;
const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);
if (!origin.startsWith("https://") && !loopback) {
  console.error("Refusing to send credentials over plain http to a non-loopback origin.");
  process.exit(2);
}
const username = process.env.RELAY_VERIFY_USERNAME;
const password = process.env.RELAY_VERIFY_PASSWORD;
if (!username || !password) {
  console.error("Set RELAY_VERIFY_USERNAME and RELAY_VERIFY_PASSWORD for the account to verify with.");
  process.exit(2);
}

const run = `relay-verify-${Date.now().toString(36)}`;
const { step, timings } = stepper();
const facts: Record<string, unknown> = { origin, run };
const created = { items: new Set<Id>(), loginCodes: new Set<Id>() };
const owner = new Session(origin);
const receiver = new Session(origin);
const events = new AbortController();

const payload = randomBytes(parseSize(flags.size));
assert(payload.length > 2 * LIMITS.chunkBytes, "--size must be more than two chunks so a middle chunk can be dropped.");
const image = await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 241, g: 107, b: 71 } } })
  .png()
  .toBuffer();
const pdf = pdfFixture();
const text = `Relay live verification ${run}\n`;
const files = [
  { path: `${run}/payload.bin`, data: payload, mime: "application/octet-stream" },
  { path: `${run}/image.png`, data: image, mime: "image/png" },
  { path: `${run}/document.pdf`, data: pdf, mime: "application/pdf" },
];
const expected = new Map([...files.map((f) => [f.path, sha256(f.data)] as const), ["Text.txt", sha256(text)]]);

/** Checks a ZIP download: exactly the fixture files (plus their folder) with the right payloads. */
async function checkZip(session: Session, path: string) {
  const res = await session.fetch(path);
  assert(res.status === 200, `ZIP answered ${res.status}.`);
  const entries = await readZip(res.body as unknown as AsyncIterable<Uint8Array>);
  const got = entries.filter((e) => !e.folder);
  assert(got.length === expected.size, `ZIP holds ${got.length} files, expected ${expected.size}.`);
  assert(new Set(got.map((e) => e.path)).size === expected.size, "ZIP contains duplicate file paths.");
  for (const entry of got)
    assert(expected.get(entry.path) === entry.sha256, `Wrong payload for ${entry.path} in the ZIP.`);
  const resumed = await resumedDownload(session, path);
  const full = await download(session, path);
  assert(resumed.sha256 === full.sha256, "A Range-resumed ZIP differs from the full ZIP.");
}

/** Opens the member event stream and resolves once the server says it is ready. */
async function holdEvents(session: Session) {
  const res = await session.fetch(urls.events(session.tab), { signal: events.signal });
  assert(res.status === 200, `The event stream answered ${res.status}.`);
  const reader = res.body!.getReader();
  let seen = "";
  while (!seen.includes("event: ready")) {
    const { value, done } = await reader.read();
    assert(!done, "The event stream closed before it was ready.");
    seen += Buffer.from(value).toString("utf8");
  }
  void (async () => {
    try {
      while (!(await reader.read()).done);
    } catch {
      // The stream was closed; that's the end of it.
    }
  })();
}

try {
  const me = await step("sign in", () => owner.signIn(username, password, `Relay verification ${run}`));
  facts.admin = me.user.admin;
  const transfer = await step(`upload ${mib(payload.length)} with a dropped chunk, then resume`, async () => {
    const transfer = await owner.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: owner.tab,
        name: `Relay verification ${run}`,
        text,
        files: files.map((f) => ({ path: f.path, size: f.data.length, mime: f.mime })),
      },
    });
    created.items.add(transfer.itemId);
    const id = transfer.uploads[0].id;
    await upload(owner, id, bufferSource(payload), { until: LIMITS.chunkBytes });
    const dropped = stalledPatch(
      owner,
      id,
      LIMITS.chunkBytes,
      payload.subarray(LIMITS.chunkBytes, LIMITS.chunkBytes + LIMITS.chunkBytes / 2),
    );
    await dropped.delivered;
    await sleep(2_000);
    dropped.abort();
    await dropped.result;
    const offset = await uploadOffset(owner, id);
    assert(
      offset === LIMITS.chunkBytes,
      `HEAD reported ${offset} after the dropped chunk, expected ${LIMITS.chunkBytes}.`,
    );
    await upload(owner, id, bufferSource(payload));
    for (const [i, f] of files.entries()) if (i > 0) await upload(owner, transfer.uploads[i].id, bufferSource(f.data));
    return transfer;
  });

  const link: Link = await step("complete to a link, twice (lost response)", async () => {
    const complete = () =>
      owner.call(api.transfers.complete, {
        params: { id: transfer.id },
        body: { destination: { kind: "link", days: 1 } },
      });
    const first = await complete();
    const again = await complete();
    assert(first.link && again.link?.id === first.link.id, "Completing again did not return the same link.");
    return first.link;
  });

  const item = await owner.call(api.items.get, { params: { id: transfer.itemId } });
  const node = (path: string) => item.nodes.find((n) => n.path === path)!;
  const [payloadNode, imageNode, pdfNode] = files.map((f) => node(f.path));

  await step("owner download, ranges and previews", async () => {
    const got = await download(owner, urls.nodeContent(payloadNode.id));
    assert(got.sha256 === expected.get(payloadNode.path), "The downloaded payload differs from the source.");
    const range = await download(owner, urls.nodeContent(pdfNode.id), { headers: { range: "bytes=0-99" } });
    assert(range.res.status === 206 && range.sha256 === sha256(pdf.subarray(0, 100)), "The PDF byte range is wrong.");
    const tail = await download(owner, urls.nodeContent(payloadNode.id), { headers: { range: `bytes=-4096` } });
    assert(tail.sha256 === sha256(payload.subarray(-4096)), "The payload suffix range is wrong.");
    for (const [n, type] of [
      [imageNode, "image/png"],
      [pdfNode, "application/pdf"],
    ] as const) {
      const inline = await download(owner, urls.nodeContent(n.id, { inline: true }));
      assert(inline.res.headers.get("content-type")?.startsWith(type), `${n.name} is not previewed inline as ${type}.`);
    }
    for (const size of ["s", "l"] as const) {
      const thumb = await download(owner, urls.nodeThumbnail(imageNode.id, size));
      assert(thumb.res.headers.get("content-type") === "image/webp" && thumb.bytes > 0, `No ${size} thumbnail.`);
    }
  });

  await step("owner ZIP: entries, hashes and a resumed download", () => checkZip(owner, urls.itemZip(item.id)));

  await step("anonymous callers cannot read owner content", async () => {
    const anonymous = new Session(origin);
    for (const path of [urls.nodeContent(payloadNode.id), urls.nodeThumbnail(imageNode.id), urls.itemZip(item.id)]) {
      const res = await anonymous.fetch(path);
      await res.body?.cancel();
      assert(res.status === 401, `${path.split("/")[2]} answered ${res.status} without credentials.`);
    }
  });

  await step("pickup code opens the share; share content, thumbnail and ZIP", async () => {
    const visitor = new Session(origin);
    const resolved = await visitor.call(api.pickup.resolve, { body: { code: link.code } });
    assert(
      resolved.kind === "share" && resolved.path === `/s/${link.token}`,
      "The pickup code resolved to a different link.",
    );
    const token = link.token;
    const share = await visitor.call(api.links.open, { params: { token } });
    assert(!share.locked && share.files === files.length && share.texts === 1, "The share lists the wrong contents.");
    const got = await download(visitor, urls.shareContent(token, payloadNode.id));
    assert(got.sha256 === expected.get(payloadNode.path), "The shared payload differs from the source.");
    await download(visitor, urls.shareThumbnail(token, imageNode.id));
    await checkZip(visitor, urls.shareZip(token));
  });

  await step("revoking the link stops public access at once", async () => {
    await owner.call(api.links.revoke, { params: { id: link.id } });
    const res = await new Session(origin).fetch(urls.shareContent(link.token, payloadNode.id));
    await res.body?.cancel();
    assert(res.status >= 400 && res.status < 500, `A revoked link still answered ${res.status}.`);
  });

  await step("login code sign-in on a second device, which receives a delivery", async () => {
    const code = await owner.call(api.loginCodes.create);
    created.loginCodes.add(code.id);
    const signedIn = await receiver.call(api.session.code, {
      body: { code: code.code, deviceName: `Relay verification receiver ${run}` },
    });
    created.loginCodes.delete(code.id);
    await holdEvents(receiver);
    let online = false;
    for (let i = 0; i < 20 && !online; i++) {
      online = !!(await owner.call(api.devices.list)).find((d) => d.id === signedIn.device.id)?.online;
      if (!online) await sleep(250);
    }
    assert(online, "The second device is not listed as online while its event stream is open.");
    const data = randomBytes(256 * 1024);
    const sent = await sendFiles(owner, [{ path: `${run}-delivery.bin`, data }], {
      name: `Relay verification delivery ${run}`,
      destination: { kind: "device", device: signedIn.device.id },
      onCreated: (transfer) => created.items.add(transfer.itemId),
    });
    created.items.add(sent.created.itemId);
    const incoming = await receiver.call(api.deliveries.list, { query: { direction: "incoming" } });
    assert(
      incoming.some((d) => d.itemId === sent.created.itemId && d.available),
      "The delivery did not arrive.",
    );
    const delivered = await receiver.call(api.items.get, { params: { id: sent.created.itemId } });
    const got = await download(receiver, urls.nodeContent(delivered.nodes[0].id));
    assert(got.sha256 === sha256(data), "The delivered file differs from the source.");
  });

  facts.checksPassed = true;
} catch (error) {
  process.exitCode = 1;
  console.error(`\nverify-deployment failed: ${errorStack(error)}`);
} finally {
  events.abort();
  const leftovers: string[] = [];
  for (const id of created.items)
    try {
      // Already in Trash is fine; removal below reports anything that is really wrong.
      await owner.call(api.items.trash, { params: { id } }).catch(() => {});
      await owner.call(api.items.remove, { params: { id } });
    } catch (error) {
      leftovers.push(`item ${id}: ${errorMessage(error)}`);
    }
  for (const id of created.loginCodes)
    await owner
      .call(api.loginCodes.revoke, { params: { id } })
      .catch((error: unknown) => leftovers.push(`login code ${id}: ${errorMessage(error)}`));
  for (const session of [receiver, owner])
    if (session.csrf)
      await session.call(api.session.signOut).catch((e) => leftovers.push(`session: ${(e as Error).message}`));
  console.log(
    leftovers.length
      ? `Cleanup incomplete:\n  ${leftovers.join("\n  ")}`
      : "Generated items, login codes and sessions cleaned up. The API cannot delete device history.",
  );
  if (leftovers.length) process.exitCode = 1;
  console.log(JSON.stringify({ passed: !process.exitCode && facts.checksPassed === true, ...facts, timings }, null, 2));
}
