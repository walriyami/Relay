import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, urls } from "../shared/api.ts";
import { LOCAL, LOCAL_TOKEN_HEADER, SOCKETS } from "../shared/local.ts";
import { LIMITS } from "../shared/model.ts";
import { lanAddresses, parseAddresses } from "../local/addresses.ts";
import { heldChannels } from "../local/channels.ts";
import { announce, startHelper } from "../local/helper.ts";
import { Client, member, start, type ApiError, type Instance } from "./support/harness.ts";
import nodeDataChannel, { type DataChannel } from "node-datachannel";
import { LocalPeer } from "./support/local-peer.ts";

// The library's threads keep the process alive until it's told to stop.
after(() => nodeDataChannel.cleanup());

type Helper = Awaited<ReturnType<typeof startHelper>>;
type Kit = { instance: Instance; dir: string; port: number; helper: Helper | null; client: Client };

/** A Relay with direct transfers, its helper announcing loopback, and a signed-in member. */
async function withLocal(run: (kit: Kit) => Promise<void>, { helper = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "relay-local-"));
  const instance = await start({ local: dir });
  await instance.app.ready();
  const port = await freeUdpPort();
  const kit: Kit = {
    instance,
    dir,
    port,
    helper: helper ? await startHelper({ dir, port, addresses: () => ["127.0.0.1"], log: () => {} }) : null,
    client: await member(instance, "tia"),
  };
  try {
    await run(kit);
  } finally {
    await kit.helper?.close();
    await instance.close();
    await rm(dir, { recursive: true, force: true });
  }
  // Every channel's close was reported, so none is left for cleanup() to trip over.
  for (const started = Date.now(); heldChannels() && Date.now() - started < 3000;)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(heldChannels(), 0);
}

/**
 * A free UDP port below the systems' ephemeral ranges, so the test's own peer, which binds an
 * ephemeral port, can't take it before the helper binds it.
 */
async function freeUdpPort() {
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 12000);
    const taken = await take(port);
    await taken.release();
    if (taken.all) return port;
  }
}

/** Binds `port` the ways the helper would: IPv4, and IPv6 where the host has it. */
async function take(port: number) {
  const bind = (type: "udp4" | "udp6") =>
    new Promise<Socket | null>((resolve) => {
      const socket = createSocket(type);
      socket.once("error", () => socket.close(() => resolve(null)));
      socket.bind(port, () => resolve(socket));
    });
  const v4 = await bind("udp4");
  // Linux refuses a dual-stack socket once IPv4 has the port; macOS binds IPv6 separately.
  const v6 = await bind("udp6");
  const sockets = [v4, v6].filter((socket) => socket !== null);
  return {
    all: v4 !== null,
    release: () => Promise.all(sockets.map((socket) => new Promise<void>((resolve) => socket.close(() => resolve())))),
  };
}

async function upload(client: Client, size: number) {
  const created = await client.call(api.transfers.create, {
    body: {
      id: crypto.randomUUID(),
      tab: client.tab,
      name: null,
      folders: [],
      files: [{ path: "big.bin", size, mime: "application/octet-stream" }],
    },
  });
  return { transfer: created.id, item: created.itemId, id: created.uploads[0].id };
}
const tus = (client: Client, offset: number) => ({
  "tus-resumable": "1.0.0",
  "upload-offset": String(offset),
  "content-type": "application/offset+octet-stream",
  "x-relay-csrf": client.csrf,
  "x-relay-tab": client.tab,
});

/** Sends a head the helper must refuse and resolves never: only its error ends the promise. */
function refuse(channel: DataChannel, head: unknown) {
  return new Promise<never>((_, reject) => {
    channel.onMessage((message) => {
      if (typeof message !== "string") return reject(new Error("unexpected bytes"));
      const control = JSON.parse(message) as { error?: string };
      reject(new Error(control.error ?? `unexpected ${message}`));
    });
    channel.sendMessage(typeof head === "string" ? head : JSON.stringify(head));
  });
}

/** A raw request on Relay's local socket, as the helper sends them. */
function onSocket(dir: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath: join(dir, SOCKETS.relay), path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += String(chunk)));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("local: a signed-in browser connects, proves the route and uploads and downloads through it", async () => {
  await withLocal(async ({ client }) => {
    assert.equal((await client.call(api.session.get)).local, true);
    const peer = await LocalPeer.connect(client);
    try {
      const check = await peer.fetch({ path: "/api/local/check" });
      assert.equal(check.status, 200);
      assert.deepEqual(JSON.parse(check.body.toString()), { ok: true });

      // Larger than the window both ways, so credit has to flow.
      const data = randomBytes(LOCAL.windowBytes * 2 + 12345);
      const { transfer, item, id } = await upload(client, data.length);
      const half = 5 * 1024 ** 2;
      let res = await peer.fetch({
        method: "PATCH",
        path: urls.upload(id),
        headers: tus(client, 0),
        body: data.subarray(0, half),
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers["upload-offset"], String(half));
      res = await peer.fetch({
        method: "HEAD",
        path: urls.upload(id),
        headers: { "tus-resumable": "1.0.0", "x-relay-tab": client.tab },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers["upload-offset"], String(half));
      res = await peer.fetch({
        method: "PATCH",
        path: urls.upload(id),
        headers: tus(client, half),
        body: data.subarray(half),
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers["upload-offset"], String(data.length));
      await client.call(api.transfers.complete, { params: { id: transfer }, body: { destination: { kind: "save" } } });

      const detail = await client.call(api.items.get, { params: { id: item } });
      const node = detail.nodes.find((n) => n.kind === "file")!;
      const file = await peer.fetch({ path: urls.nodeContent(node.id) });
      assert.equal(file.status, 200);
      assert.equal(file.headers["content-length"], String(data.length));
      assert.match(file.headers["content-disposition"], /^attachment;/);
      assert.ok(file.body.equals(data));

      // A download that fell back mid-way resumes from where it stood, if the file is the same.
      const rest = await peer.fetch({
        path: urls.nodeContent(node.id),
        headers: { range: "bytes=1000-", "if-range": file.headers.etag },
      });
      assert.equal(rest.status, 206);
      assert.ok(rest.body.equals(data.subarray(1000)));

      const zip = await peer.fetch({ path: urls.itemZip(item) });
      assert.equal(zip.status, 200);
      assert.equal(zip.headers["content-type"], "application/zip");
    } finally {
      peer.close();
    }
  });
});

test("local: the helper holds back a response until the browser returns credit", async () => {
  await withLocal(async ({ client }) => {
    const data = randomBytes(LOCAL.windowBytes * 3);
    const { transfer, item, id } = await upload(client, data.length);
    const peer = await LocalPeer.connect(client);
    try {
      for (let offset = 0; offset < data.length; offset += 8 * 1024 ** 2) {
        const res = await peer.fetch({
          method: "PATCH",
          path: urls.upload(id),
          headers: tus(client, offset),
          body: data.subarray(offset, offset + 8 * 1024 ** 2),
        });
        assert.equal(res.status, 204);
      }
      await client.call(api.transfers.complete, { params: { id: transfer }, body: { destination: { kind: "save" } } });
      const node = (await client.call(api.items.get, { params: { id: item } })).nodes.find((n) => n.kind === "file")!;
      // Every credit is returned late; by then, the helper must not have sent past what it was allowed.
      const seen: { received: number; allowed: number }[] = [];
      const file = await peer.fetch({
        path: urls.nodeContent(node.id),
        creditDelayMs: 150,
        onCredit: (received, allowed) => seen.push({ received, allowed }),
      });
      assert.ok(file.body.equals(data));
      assert.ok(seen.length > 0);
      for (const { received, allowed } of seen)
        assert.ok(received <= allowed, `${received - allowed} bytes past credit`);
      // And it did use the window it had, rather than trickle.
      assert.ok(seen.some(({ received, allowed }) => allowed - received < LOCAL.messageBytes));
    } finally {
      peer.close();
    }
  });
});

test("local: requests keep their protections and end with the session", async () => {
  await withLocal(async ({ client }) => {
    const peer = await LocalPeer.connect(client);
    try {
      const data = randomBytes(1000);
      const { id } = await upload(client, data.length);
      // CSRF still applies to what a page sends.
      const headers: Record<string, string> = tus(client, 0);
      delete headers["x-relay-csrf"];
      let res = await peer.fetch({ method: "PATCH", path: urls.upload(id), headers, body: data });
      assert.equal(res.status, 403);

      // Anything but the bulk routes, and any body longer than one chunk, is refused by the helper
      // before it reaches Relay.
      const refused = /can't travel on this connection/;
      await assert.rejects(peer.fetch({ path: "/api/session" }), refused);
      await assert.rejects(peer.fetch({ method: "POST", path: urls.upload(id) }), refused);
      await assert.rejects(
        refuse(await peer.channel(), {
          method: "PATCH",
          path: urls.upload(id),
          headers: {},
          length: LIMITS.chunkBytes + 1,
        }),
        refused,
      );
      await assert.rejects(
        refuse(await peer.channel(), { method: "GET", path: urls.nodeContent(id), headers: {}, length: 1 }),
        refused,
      );
      await assert.rejects(refuse(await peer.channel(), "not json"), refused);

      await client.call(api.session.signOut);
      res = await peer.fetch({ path: "/api/local/check" });
      assert.equal(res.status, 401);
    } finally {
      peer.close();
    }
  });
});

test("local: Relay's socket serves only the bulk routes, only with a local token", async () => {
  await withLocal(async ({ instance, dir, client }) => {
    const me = await client.call(api.session.get);
    const session = instance.ctx.db.value<string>("SELECT token_hash FROM sessions WHERE device_id = ?", me.device.id)!;
    const token = instance.ctx.secrets.localToken(session);

    assert.equal((await onSocket(dir, "/api/local/check")).status, 421);
    assert.equal((await onSocket(dir, "/api/local/check", { [LOCAL_TOKEN_HEADER]: `${session}.forged` })).status, 421);
    assert.equal((await onSocket(dir, "/api/local/check", { [LOCAL_TOKEN_HEADER]: token })).status, 200);
    assert.equal((await onSocket(dir, "/api/session", { [LOCAL_TOKEN_HEADER]: token })).status, 404);
    assert.equal((await onSocket(dir, "/api/items", { [LOCAL_TOKEN_HEADER]: token })).status, 404);
    assert.equal(instance.ctx.secrets.localSession(token), session);
    assert.equal(instance.ctx.secrets.localSession(`${"0".repeat(64)}.${token.split(".")[1]}`), null);

    // The check answers only through the socket.
    const direct = await client.raw({ method: "GET", url: "/api/local/check" });
    assert.equal(direct.statusCode, 404);
  });
});

test("local: connecting needs the feature, a running helper and a data offer", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    assert.equal((await client.call(api.session.get)).local, false);
    await assert.rejects(client.call(api.local.connect, { body: { offer: "v=0" } }), (e: ApiError) => e.status === 404);
  } finally {
    await instance.close();
  }
  await withLocal(
    async ({ client }) => {
      await assert.rejects(
        client.call(api.local.connect, { body: { offer: "v=0" } }),
        (e: ApiError) => e.status === 503,
      );
    },
    { helper: false },
  );
  await withLocal(async ({ client, port }) => {
    await assert.rejects(
      client.call(api.local.connect, { body: { offer: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" } }),
      (e: ApiError) => e.status === 400,
    );
    // A helper that can't take its port is unavailable; the offer was fine.
    const taken = await take(port);
    try {
      await assert.rejects(LocalPeer.connect(client), (e: ApiError) => e.status === 503);
    } finally {
      await taken.release();
    }
    const anonymous = await new Client(client.instance).raw({
      method: "POST",
      url: "/api/local/connect",
      payload: { offer: "v=0" },
    });
    assert.equal(anonymous.statusCode, 401);
  });
});

test("local: closing a channel abandons its request, and the upload resumes from what arrived", async () => {
  await withLocal(async ({ client }) => {
    const data = randomBytes(6 * 1024 ** 2);
    const { id } = await upload(client, data.length);
    const peer = await LocalPeer.connect(client);
    try {
      const channel = await peer.channel();
      channel.sendMessage(
        JSON.stringify({ method: "PATCH", path: urls.upload(id), headers: tus(client, 0), length: data.length }),
      );
      for (let at = 0; at < 2 * 1024 ** 2; at += LOCAL.messageBytes)
        channel.sendMessageBinary(data.subarray(at, at + LOCAL.messageBytes));
      await new Promise((resolve) => setTimeout(resolve, 300));
      channel.close();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const head = await peer.fetch({
        method: "HEAD",
        path: urls.upload(id),
        headers: { "tus-resumable": "1.0.0", "x-relay-tab": client.tab },
      });
      const offset = Number(head.headers["upload-offset"]);
      assert.ok(offset < data.length);
      const rest = await peer.fetch({
        method: "PATCH",
        path: urls.upload(id),
        headers: tus(client, offset),
        body: data.subarray(offset),
      });
      assert.equal(rest.status, 204);
      assert.equal(rest.headers["upload-offset"], String(data.length));
    } finally {
      peer.close();
    }
  });
});

test("local: the answer announces only the helper's addresses, on its one port", () => {
  const answer = [
    "v=0",
    "m=application 61234 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 172.17.0.1",
    "a=mid:0",
    "a=candidate:1 1 UDP 2114977535 172.17.0.1 61234 typ host",
    "a=candidate:2 1 UDP 2114977535 192.168.1.20 61234 typ host",
    "a=end-of-candidates",
    "",
  ].join("\r\n");
  const lines = announce(answer, ["192.168.1.20", "fd00::20"], 3090).split("\r\n");
  assert.deepEqual(
    lines.filter((l) => l.startsWith("a=candidate")),
    [
      `a=candidate:1 1 UDP ${126 * 2 ** 24 + 65535 * 256 + 255} 192.168.1.20 3090 typ host`,
      `a=candidate:2 1 UDP ${126 * 2 ** 24 + 65534 * 256 + 255} fd00::20 3090 typ host`,
    ],
  );
  assert.ok(lines.includes("m=application 3090 UDP/DTLS/SCTP webrtc-datachannel"));
  assert.ok(lines.includes("c=IN IP4 192.168.1.20"));
  assert.equal(lines.filter((l) => l === "a=end-of-candidates").length, 1);
});

test("local: the helper announces private addresses of real interfaces, IPv4 first", () => {
  const entry = (address: string, family: "IPv4" | "IPv6", internal = false) =>
    ({ address, family, internal, netmask: "", mac: "", cidr: null }) as never;
  assert.deepEqual(
    lanAddresses({
      lo: [entry("127.0.0.1", "IPv4", true)],
      eth0: [
        entry("fd12:3456::1", "IPv6"),
        entry("192.168.1.20", "IPv4"),
        entry("2001:db8::1", "IPv6"),
        entry("fe80::1", "IPv6"),
      ],
      wlan0: [entry("10.0.0.5", "IPv4"), entry("100.64.1.1", "IPv4")],
      docker0: [entry("172.17.0.1", "IPv4")],
      "br-1a2b": [entry("172.31.247.1", "IPv4")],
      veth12: [entry("172.18.0.1", "IPv4")],
      enp3s0: [entry("172.20.1.9", "IPv4"), entry("8.8.8.8", "IPv4")],
    }),
    ["192.168.1.20", "10.0.0.5", "172.20.1.9", "fd12:3456::1"],
  );
  assert.deepEqual(parseAddresses(" 192.168.1.20, fd00::1 ,192.168.1.20"), ["192.168.1.20", "fd00::1"]);
  assert.throws(() => parseAddresses("relay.lan"), /RELAY_LOCAL_ADDRESSES/);
});
