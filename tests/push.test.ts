import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { allowedEndpoint, PUSH_SERVICES } from "../server/modules/push/index.ts";
import { encrypt } from "../server/modules/push/webpush.ts";
import { api, urls } from "../shared/api.ts";
import type { ActivityEntry } from "../shared/model.ts";
import { eventually } from "./support/event-stream.ts";
import { ApiError, Client, member, openShare, patchUpload, send, start, type Instance } from "./support/harness.ts";

const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64url");
const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

type Received = { path: string; headers: IncomingHttpHeaders; body: Buffer };
type Notice = { title: string; body: string; url: string; tag: string };

/** A stand-in for a browser's push service: records what Relay posts, answers 201, or 410 under /gone/. */
async function pushService() {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url?.startsWith("/gone/") ? 410 : 201).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A browser's side of one subscription: its keys, and decrypting what arrives for it. */
function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) };
  const decrypt = (body: Buffer): Notice => {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen);
    const data = body.subarray(21 + idlen);
    const shared = ecdh.computeSecret(asPublic);
    const info = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync("sha256", shared, auth, info, 32));
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(data.subarray(-16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
    assert.equal(plain.at(-1), 2, "a single, last record");
    return JSON.parse(plain.subarray(0, -1).toString("utf8")) as Notice;
  };
  return { keys, decrypt };
}

/** Checks the VAPID signature against the key the server hands browsers. */
function assertSigned(headers: IncomingHttpHeaders, key: string, audience: string) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(String(headers.authorization));
  assert.ok(match, "a VAPID authorization");
  assert.equal(match[2], key);
  const [head, claims, signature] = match[1].split(".");
  const point = Buffer.from(key, "base64url");
  const publicKey = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64(point.subarray(1, 33)), y: b64(point.subarray(33)) },
    format: "jwk",
  });
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${head}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
  );
  const body = JSON.parse(Buffer.from(claims, "base64url").toString()) as { aud: string; exp: number };
  assert.equal(body.aud, audience);
  assert.ok(body.exp > Date.now() / 1000 && body.exp <= Date.now() / 1000 + 24 * 3600);
  assert.equal(headers["content-encoding"], "aes128gcm");
}

/** `browser` is the same browser subscribing again, with the keys it made the first time. */
async function subscribe(client: Client, endpoint: string, browser = browserKeys()) {
  await client.call(api.push.subscribe, { body: { endpoint, keys: browser.keys } });
  return browser;
}

/** Keeps a device's live connection open, as an open Relay tab does (deliveries need one). */
async function connect(instance: Instance, client: Client) {
  const base = await instance.app.listen({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const req = request(
      base + urls.events(client.tab) + `&browser=${client.tab}`,
      { agent: false, headers: { cookie, host: "relay.test" } },
      (res) => {
        res.once("data", () => resolve());
        res.resume();
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("only a signed-in member reaches the notification routes, and only with the page's token", async () => {
  const instance = await start();
  try {
    const stranger = new Client(instance);
    for (const [method, url] of [
      ["GET", "/api/push"],
      ["POST", "/api/push"],
      ["DELETE", "/api/push"],
      ["POST", "/api/push/test"],
    ] as const) {
      const res = await stranger.raw({
        method,
        url,
        ...(method === "POST" && url === "/api/push" ? { payload: {} } : {}),
      });
      assert.ok([401, 403].includes(res.statusCode), `${method} ${url} refused a stranger: ${res.statusCode}`);
    }
    const client = await member(instance, "ana");
    const { keys } = browserKeys();
    const forged = await client.raw({
      method: "POST",
      url: "/api/push",
      headers: { "x-relay-csrf": "forged" },
      payload: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys },
    });
    assert.equal(forged.statusCode, 403, "another site's page can't subscribe a member's browser");
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM push_subscriptions"), 0);
  } finally {
    await instance.close();
  }
});

test("Relay only posts to the browsers' push services", async () => {
  assert.ok(allowedEndpoint("https://fcm.googleapis.com/fcm/send/abc", PUSH_SERVICES));
  assert.ok(allowedEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc", PUSH_SERVICES));
  assert.ok(allowedEndpoint("https://web.push.apple.com/abc", PUSH_SERVICES));
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.example.com/abc",
    "https://example.com/fcm.googleapis.com",
    "https://user:pass@fcm.googleapis.com/abc",
    "https://127.0.0.1/abc",
    "not a url",
  ])
    assert.equal(allowedEndpoint(endpoint, PUSH_SERVICES), false, endpoint);

  const instance = await start();
  try {
    const client = await member(instance, "ben");
    const { keys } = browserKeys();
    assert.equal(
      await status(client.call(api.push.subscribe, { body: { endpoint: "https://192.168.1.1/admin", keys } })),
      400,
    );
    assert.equal(
      await status(
        client.call(api.push.subscribe, {
          body: {
            endpoint: "https://fcm.googleapis.com/fcm/send/abc",
            keys: { ...keys, p256dh: b64(randomBytes(65)) },
          },
        }),
      ),
      400,
      "a key that isn't a P-256 point is refused",
    );
    const before = await client.call(api.push.status);
    assert.equal(before.subscribed, false);
    assert.equal(Buffer.from(before.key, "base64url").length, 65);
    await client.call(api.push.subscribe, { body: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys } });
    assert.equal((await client.call(api.push.status)).subscribed, true);
    assert.equal((await client.call(api.push.status)).key, before.key, "the key is kept");
    await client.call(api.push.unsubscribe);
    assert.equal((await client.call(api.push.status)).subscribed, false);
  } finally {
    await instance.close();
  }
});

test("an arrival notifies only the device it was sent to, encrypted and signed", async () => {
  const service = await pushService();
  const instance = await start({ pushServices: [service.origin] });
  try {
    const laptop = await member(instance, "cai");
    const phone = new Client(instance);
    const phoneMe = await phone.signIn("cai", "Member-password-only", "Phone");
    await connect(instance, phone);
    const phoneBrowser = await subscribe(phone, `${service.origin}/phone`);
    await subscribe(laptop, `${service.origin}/laptop`);
    const { key } = await phone.call(api.push.status);

    const { result } = await send(laptop, [{ path: "photo.jpg", data: "jpeg", mime: "image/jpeg" }], { name: "Beach" });
    await laptop.call(api.deliveries.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, device: phoneMe.device.id },
    });
    await eventually(() => service.received.length === 1);
    const [sent] = service.received;
    assert.equal(sent.path, "/phone");
    assertSigned(sent.headers, key, service.origin);
    assert.equal(sent.headers.urgency, "high");
    const notice = phoneBrowser.decrypt(sent.body);
    assert.deepEqual(
      { title: notice.title, body: notice.body, url: notice.url },
      { title: "From cai browser", body: "“Beach” is waiting on this device.", url: "/" },
    );
    assert.equal(sent.body.includes(Buffer.from("Beach")), false, "the push service can't read it");

    const { sent: tested } = await phone.call(api.push.test);
    assert.equal(tested, true);
    assert.equal(phoneBrowser.decrypt(service.received[1].body).title, "Notifications are on");
  } finally {
    await instance.close();
    await service.close();
  }
});

test("files sent to a request notify its owner, unless they turned request activity off", async () => {
  const service = await pushService();
  const instance = await start({ pushServices: [service.origin] });
  try {
    const owner = await member(instance, "dee");
    const browser = await subscribe(owner, `${service.origin}/dee`);
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Tax papers", description: "", days: 5, maxBytes: 1000 },
    });
    const upload = async (sender: string) => {
      const guest = new Client(instance);
      await guest.call(api.requests.start, { params: { token: request.token } });
      const transfer = await guest.call(api.requests.transfer, {
        params: { token: request.token },
        body: {
          id: crypto.randomUUID(),
          tab: guest.tab,
          folders: [],
          sender,
          files: [{ path: "a.pdf", size: 3, mime: "application/pdf" }],
        },
      });
      assert.equal((await patchUpload(guest, transfer.uploads[0].id, 0, Buffer.alloc(3))).statusCode, 204);
      await guest.call(api.transfers.complete, {
        params: { id: transfer.id },
        body: { destination: { kind: "save" } },
      });
    };
    await upload("Dana");
    await eventually(() => service.received.length === 1);
    assert.deepEqual(browser.decrypt(service.received[0].body), {
      title: "New files for “Tax papers”",
      body: "Dana sent 1 file.",
      url: `/requests/${request.id}`,
      tag: `request:${request.id}`,
    });

    await owner.call(api.account.update, { body: { prefs: { activity: { requests: false } } } });
    await upload("Eve");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(service.received.length, 1, "the bell and notifications follow the same choice");
  } finally {
    await instance.close();
    await service.close();
  }
});

test("a link notifies its owner on its first download only", async () => {
  const service = await pushService();
  const instance = await start({ pushServices: [service.origin] });
  try {
    const owner = await member(instance, "fay");
    const browser = await subscribe(owner, `${service.origin}/fay`);
    const { result } = await send(owner, [{ path: "a.txt", data: "alpha", mime: "text/plain" }], { name: "Notes" });
    const link = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const visit = async () => {
      const visitor = new Client(instance);
      const share = await openShare(visitor, link.token);
      const file = share.nodes.find((n) => n.kind === "file")!.id;
      assert.equal((await visitor.raw({ method: "GET", url: urls.shareContent(link.token, file) })).statusCode, 200);
    };
    await visit();
    await eventually(() => service.received.length === 1);
    const notice = browser.decrypt(service.received[0].body);
    assert.equal(notice.title, "“Notes” was downloaded");
    assert.equal(notice.url, `/links/${link.id}`);
    await visit();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(service.received.length, 1, "later downloads stay in Activity");
  } finally {
    await instance.close();
    await service.close();
  }
});

// A link's visitors decide when a first download is recorded, so telling the owner must cost a few
// lookups by key: not a pass over everything the owner's Activity holds, with notifications on or off.
test("telling an owner about a link's first download costs the same however much Activity holds", async () => {
  const service = await pushService();
  const instance = await start({ pushServices: [service.origin] });
  try {
    const owner = await member(instance, "ivy");
    const { result } = await send(owner, [{ path: "a.txt", data: "alpha", mime: "text/plain" }], { name: "Notes" });
    const link = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const db = instance.ctx.db as unknown as { prepare(sql: string): unknown };
    const prepare = db.prepare.bind(db);
    const seen = new Set<string>();
    db.prepare = (sql: string) => (seen.add(sql), prepare(sql));
    const download = async () => {
      const visitor = new Client(instance);
      const share = await openShare(visitor, link.token);
      const file = share.nodes.find((n) => n.kind === "file")!.id;
      assert.equal((await visitor.raw({ method: "GET", url: urls.shareContent(link.token, file) })).statusCode, 200);
    };
    const plans = () =>
      [...seen].flatMap((sql) =>
        instance.ctx.db.sqlite
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => null))
          .map((row) => `${String(row.detail)}  <-  ${sql.replace(/\s+/g, " ")}`),
      );
    // Reading the entry just recorded, by its id, is the one way in that costs the same for every owner.
    const readsActivity = (plan: string[]) =>
      plan.filter((step) => /^(SCAN|SEARCH) activity\b/.test(step) && !/\(id=\?\) {2}<-/.test(step));

    // Without notifications, a first download reads no more than its own entry.
    await download();
    assert.deepEqual(readsActivity(plans()), []);

    // With them, the owner hears of the first download only, found through the link's own visitors.
    const browser = await subscribe(owner, `${service.origin}/ivy`);
    const second = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    seen.clear();
    const visitor = new Client(instance);
    const share = await openShare(visitor, second.token);
    const file = share.nodes.find((n) => n.kind === "file")!.id;
    await visitor.raw({ method: "GET", url: urls.shareContent(second.token, file) });
    await eventually(() => service.received.length === 1);
    assert.equal(browser.decrypt(service.received[0].body).title, "“Notes” was downloaded");
    const plan = plans();
    assert.deepEqual(readsActivity(plan), []);
    assert.ok(plan.some((step) => /SEARCH link_visits USING (COVERING )?INDEX link_visits_downloaded/.test(step)));
    db.prepare = prepare;
  } finally {
    await instance.close();
    await service.close();
  }
});

test("a subscription is forgotten when the browser drops it, the device signs out, or another account takes the browser", async () => {
  const service = await pushService();
  const instance = await start({ pushServices: [service.origin] });
  try {
    const client = await member(instance, "gus");
    await subscribe(client, `${service.origin}/gone/1`);
    await client.call(api.push.test);
    assert.equal((await client.call(api.push.status)).subscribed, false, "410 from the push service removes it");

    const endpoint = `${service.origin}/shared-browser`;
    const shared = await subscribe(client, endpoint);
    const other = await member(instance, "hal");
    // Knowing the endpoint isn't enough: someone elsewhere can't take gus's notifications away.
    assert.equal(await status(subscribe(other, endpoint)), 409);
    assert.equal((await client.call(api.push.status)).subscribed, true, "gus keeps his notifications");
    assert.equal((await other.call(api.push.status)).subscribed, false);
    // On the browser itself, which holds the subscription's keys, the account signed in now gets them.
    await subscribe(other, endpoint, shared);
    assert.equal((await client.call(api.push.status)).subscribed, false, "one browser, one subscription");
    assert.equal((await other.call(api.push.status)).subscribed, true);
    // The same account signing in again on that browser keeps it too, whatever keys it sends.
    const again = new Client(instance);
    await again.signIn("hal", "Member-password-only");
    await subscribe(again, endpoint);
    assert.equal((await other.call(api.push.status)).subscribed, false);
    assert.equal((await again.call(api.push.status)).subscribed, true);

    await again.call(api.session.signOut);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM push_subscriptions"), 0, "signing out forgets it");

    const deviceOwner = await member(instance, "ivy");
    await subscribe(deviceOwner, `${service.origin}/ivy`);
    const { device } = await deviceOwner.call(api.session.get);
    instance.ctx.db.run("DELETE FROM sessions WHERE device_id = ?", device.id);
    assert.equal(
      instance.ctx.db.value("SELECT count(*) FROM push_subscriptions"),
      0,
      "an expired or revoked session too",
    );
  } finally {
    await instance.close();
    await service.close();
  }
});

test("a share that reaches the server without Relay's worker is discarded, not stored", async () => {
  const instance = await start();
  try {
    const boundary = "----relay";
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="secret.txt"',
      "Content-Type: text/plain",
      "",
      "secret contents",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const res = await new Client(instance).raw({
      method: "POST",
      url: "/share",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, "/share?id=failed");
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM blobs"), 0);
  } finally {
    await instance.close();
  }
});

test("the bell's badge is for news: not your own or routine sign-ins, nor a link only opened", async () => {
  const instance = await start();
  try {
    const laptop = await member(instance, "joy");
    const feed = async (client: Client) => (await client.call(api.activity.list)).entries;
    const latest = async (client: Client): Promise<ActivityEntry> => (await feed(client))[0];
    assert.equal((await latest(laptop)).news, false, "joining is this device's own sign-in");

    const desktop = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0 Safari/537.36" };
    const again = new Client(instance);
    await again.raw({
      method: "POST",
      url: "/api/session/password",
      headers: desktop,
      payload: { username: "joy", password: "Member-password-only", deviceName: "joy browser" },
    });
    const familiar = await latest(laptop);
    assert.ok(familiar.kind === "signin" && familiar.familiar === true);
    assert.equal(familiar.news, false, "the same browser signing in again is routine");

    const phone = new Client(instance);
    await phone.raw({
      method: "POST",
      url: "/api/session/password",
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile Safari/604.1" },
      payload: { username: "joy", password: "Member-password-only", deviceName: "iPhone" },
    });
    const unfamiliar = await latest(laptop);
    assert.ok(unfamiliar.kind === "signin" && unfamiliar.device === "iPhone");
    assert.equal(unfamiliar.news, true, "a new kind of device is worth a look");

    const { result } = await send(laptop, [{ path: "a.txt", data: "alpha", mime: "text/plain" }], { name: "Notes" });
    const link = await laptop.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const visitor = new Client(instance);
    const share = await openShare(visitor, link.token);
    const opened = await latest(laptop);
    assert.ok(opened.kind === "link" && opened.action === "opened");
    assert.equal(opened.news, false, "an open alone isn't badged");
    const file = share.nodes.find((n) => n.kind === "file")!.id;
    await visitor.raw({ method: "GET", url: urls.shareContent(link.token, file) });
    const downloaded = await latest(laptop);
    assert.ok(downloaded.kind === "link" && downloaded.action === "downloaded");
    assert.equal(downloaded.news, true);
  } finally {
    await instance.close();
  }
});

test("push messages are encrypted as RFC 8291 specifies", () => {
  // The worked example in RFC 8291 section 5.
  const body = encrypt(
    Buffer.from("When I grow up, I want to be a watermelon"),
    {
      p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
    {
      privateKey: Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"),
      salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"),
    },
  );
  assert.equal(
    b64(body),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});
