// What a stranger can make Relay do before it knows who they are: read a body, look up cookies,
// learn about activity or the build, or see their own address echoed back.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { api, headers, urls } from "../shared/api.ts";
import { LIMITS, type StreamReady } from "../shared/model.ts";
import { build } from "../server/build-info.ts";
import { MAX_GUEST_COOKIES } from "../server/lib/auth.ts";
import { randomToken } from "../server/lib/secrets.ts";
import { MAX_LARGE_GUEST_BODIES, MAX_LARGE_GUEST_BODIES_EACH } from "../server/lib/http.ts";
import { Client, admin, member, start, type Instance } from "./support/harness.ts";
import { eventually, listen, Stream } from "./support/event-stream.ts";

/**
 * Sends the headers of a POST declaring a body of `size` bytes, then only its first bytes. `answer`
 * is whatever Relay answers before the rest: it can't have parsed a body it never got.
 */
function postUnfinished(
  address: string,
  path: string,
  { cookie = "", csrf = "", size = LIMITS.manifestBytes - 1024, from = "" } = {},
) {
  const { hostname, port } = new URL(address);
  const socket = connect(Number(port), hostname);
  const answer = new Promise<string>((resolve, reject) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString("latin1");
      const head = text.indexOf("\r\n\r\n");
      const length = /\r\ncontent-length: (\d+)/i.exec(text.slice(0, head));
      if (head >= 0 && length && text.length >= head + 4 + Number(length[1])) resolve(text);
    });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
  socket.write(
    [
      `POST ${path} HTTP/1.1`,
      "Host: relay.test",
      "Content-Type: application/json",
      `Content-Length: ${size}`,
      ...(cookie ? [`Cookie: ${cookie}`] : []),
      ...(csrf ? [`X-Relay-CSRF: ${csrf}`] : []),
      // Relay takes the loopback proxy's word for where a request comes from.
      ...(from ? [`X-Forwarded-For: ${from}`] : []),
      "",
      `{"id":"${crypto.randomUUID()}","files":[`,
    ].join("\r\n"),
  );
  return { socket, answer };
}
/** Relay's answer to a POST whose body never finishes arriving. */
async function refusedEarly(address: string, path: string, options: Parameters<typeof postUnfinished>[2] = {}) {
  const { socket, answer } = postUnfinished(address, path, options);
  const timeout = setTimeout(() => socket.destroy(new Error("Relay waited for the body.")), 5000);
  try {
    return await answer;
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
}
const statusOf = (answer: string) => Number(answer.split(" ")[1]);

async function openRequest(owner: Client) {
  return owner.call(api.requests.create, {
    body: { id: crypto.randomUUID(), name: "Scans", description: "", days: 5, maxBytes: 1000 },
  });
}
async function guestOf(instance: Instance, token: string) {
  const guest = new Client(instance);
  await guest.call(api.requests.start, { params: { token } });
  return guest;
}
const cookieHeader = (client: Client) => [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

test("a stranger's large upload manifest is refused before Relay reads it", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "xena");
    const request = await openRequest(owner);
    const other = await openRequest(owner);
    const elsewhere = await guestOf(instance, other.token);
    const address = await listen(instance);

    const anonymous = await refusedEarly(address, api.transfers.create.path);
    assert.equal(statusOf(anonymous), 401, anonymous);
    assert.match(anonymous, /\r\ncontent-security-policy: /i, "Relay's own headers, as on any answer");

    const guestRoute = `/api/r/${request.token}/transfers`;
    assert.equal(statusOf(await refusedEarly(address, guestRoute)), 401, "no grant");
    // A grant for another request is no credential for this one.
    const borrowed = { cookie: cookieHeader(elsewhere), csrf: elsewhere.csrf };
    assert.equal(statusOf(await refusedEarly(address, guestRoute, borrowed)), 401);
    assert.equal(statusOf(await refusedEarly(address, `/api/r/${randomToken()}/transfers`)), 404);
    // Smaller member-only routes are refused just as early.
    assert.equal(statusOf(await refusedEarly(address, api.admin.invite.path, { size: 1000 })), 401);

    // A member's session, or the request's own guest, still gets to send one.
    const visitor = await guestOf(instance, request.token);
    await visitor.call(api.requests.transfer, {
      params: { token: request.token },
      body: { id: crypto.randomUUID(), tab: visitor.tab, folders: [], files: [{ path: "a.pdf", size: 3 }] },
    });
    await owner.call(api.transfers.create, {
      body: { id: crypto.randomUUID(), tab: owner.tab, name: null, folders: [], files: [{ path: "a.pdf", size: 3 }] },
    });
  } finally {
    await instance.close();
  }
});

test("a request link's guests can have only a few large manifests read at once", async () => {
  const instance = await start();
  const held: ReturnType<typeof postUnfinished>[] = [];
  try {
    const owner = await member(instance, "xena");
    const links: { token: string; path: string; visitor: Client; credential: { cookie: string; csrf: string } }[] = [];
    for (let i = 0; i < 4; i++) {
      const request = await openRequest(owner);
      const visitor = await guestOf(instance, request.token);
      links.push({
        token: request.token,
        path: `/api/r/${request.token}/transfers`,
        visitor,
        credential: { cookie: cookieHeader(visitor), csrf: visitor.csrf },
      });
    }
    const address = await listen(instance);

    // What Relay answers within a moment, or "waited" while it waits for the body.
    const promptly = async (path: string, credential: { cookie: string; csrf: string; from?: string }) => {
      const { socket, answer } = postUnfinished(address, path, credential);
      const got = await Promise.race([answer, new Promise<string>((resolve) => setTimeout(resolve, 200, "waited"))]);
      socket.destroy();
      return got;
    };
    const unfinished = (link: (typeof links)[number], from: string) =>
      held.push(postUnfinished(address, link.path, { ...link.credential, from }));
    const [first, second, third, fourth] = links;

    // One link, or one network, may hold only its share of the places: Relay waits for these bodies...
    for (let i = 0; i < MAX_LARGE_GUEST_BODIES_EACH; i++) unfinished(first, "198.51.100.1");
    let busy = "";
    await eventually(
      async () => statusOf((busy = await promptly(first.path, { ...first.credential, from: "203.0.113.1" }))) === 503,
    );
    assert.match(busy, /\r\nretry-after: 5\r\n/i);
    // ...the same network on another link is refused too, and another network on another link is not.
    assert.equal(statusOf(await promptly(second.path, { ...second.credential, from: "198.51.100.2" })), 503);
    assert.equal(await promptly(second.path, { ...second.credential, from: "203.0.113.1" }), "waited");
    // Once every place is taken, nobody else is read.
    unfinished(second, "203.0.113.1");
    unfinished(third, "192.0.2.1");
    assert.equal(MAX_LARGE_GUEST_BODIES, 2 * MAX_LARGE_GUEST_BODIES_EACH);
    await eventually(
      async () => statusOf(await promptly(fourth.path, { ...fourth.credential, from: "233.252.0.1" })) === 503,
    );
    // A small one never waits for them, and neither does a member's large one.
    await fourth.visitor.call(api.requests.transfer, {
      params: { token: fourth.token },
      body: { id: crypto.randomUUID(), tab: fourth.visitor.tab, folders: [], files: [{ path: "a.pdf", size: 3 }] },
    });
    const owned = { cookie: cookieHeader(owner), csrf: owner.csrf };
    assert.equal(await promptly(api.transfers.create.path, owned), "waited");

    // Their places free up when they're cut off.
    for (const { socket } of held) socket.destroy();
    await eventually(
      async () => (await promptly(first.path, { ...first.credential, from: "198.51.100.1" })) === "waited",
    );
  } finally {
    for (const { socket } of held) socket.destroy();
    await instance.close();
  }
});

test("made-up guest cookies cost one lookup per check, of at most a fixed number", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "xena");
    const requests = [await openRequest(owner), await openRequest(owner), await openRequest(owner)];
    const visitor = new Client(instance);
    for (const request of requests) await visitor.call(api.requests.start, { params: { token: request.token } });
    const real = [...visitor.cookies].filter(([name]) => name.startsWith("relay_guest_"));
    assert.equal(real.length, 3);

    // Hundreds of junk cookies, most of them well formed, sent before the real ones.
    const junk = Array.from({ length: 300 }, (_, i) =>
      i % 3 ? [`relay_guest_${crypto.randomUUID()}`, randomToken()] : [`relay_guest_x${i}`, "v"],
    );
    visitor.cookies.clear();
    for (const [name, value] of [...junk, ...real]) visitor.cookies.set(name, value);

    // Every lookup of the cookies' grants, by how many cookies it names.
    const lookups: number[] = [];
    const record = (sql: string, ...args: unknown[]) => {
      if (/FROM guest_grants g\b.*WHERE g\.token_hash IN/s.test(sql)) lookups.push(args.length - 2);
    };
    const db = instance.ctx.db;
    const all = db.all.bind(db);
    const get = db.get.bind(db);
    mock.method(db, "all", (sql: string, ...args: never[]) => (record(sql, ...args), all(sql, ...args)));
    mock.method(db, "get", (sql: string, ...args: never[]) => (record(sql, ...args), get(sql, ...args)));
    try {
      // Routes that don't act for a guest don't look the cookies up at all.
      assert.equal((await visitor.raw({ url: api.health.path })).statusCode, 200);
      assert.equal(lookups.length, 0);

      // Each open request still works, from one lookup of the newest well-formed cookies before its
      // body is read and one after.
      for (const request of requests) {
        lookups.length = 0;
        // Each request's guest is its own principal, with its own page.
        const tab = crypto.randomUUID().replaceAll("-", "");
        await visitor.call(api.requests.transfer, {
          params: { token: request.token },
          body: { id: crypto.randomUUID(), tab, folders: [], files: [{ path: "a.pdf", size: 3 }] },
        });
        assert.deepEqual(
          lookups,
          [MAX_GUEST_COOKIES, MAX_GUEST_COOKIES],
          "one lookup each time, of the newest well-formed cookies",
        );
      }
    } finally {
      mock.restoreAll();
    }
  } finally {
    await instance.close();
  }
});

test("the change count is only for members", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "xena");
    const request = await openRequest(owner);
    const visitor = await guestOf(instance, request.token);
    const anonymous = new Client(instance);
    for (const client of [anonymous, visitor])
      for (const url of [api.health.path, api.setup.status.path, `/api/r/${request.token}`])
        assert.equal((await client.raw({ url })).headers[headers.changes.toLowerCase()], undefined, url);
    for (const url of [api.health.path, api.session.get.path])
      assert.match(String((await owner.raw({ url })).headers[headers.changes.toLowerCase()]), /^[\w-]+\.\d+$/);

    // Nor does a guest's event stream say where the count stood when it opened; a member's does.
    const base = await listen(instance);
    const readyOf = async (url: string, client: Client) => {
      const stream = await Stream.open(base, url, client);
      await stream.until((events) => events.some((event) => event.startsWith("event: ready\n")));
      await stream.close();
      const event = stream.events.find((event) => event.startsWith("event: ready\n"))!;
      return JSON.parse(event.split("data: ")[1]) as StreamReady;
    };
    assert.equal((await readyOf(urls.guestEvents(request.token, visitor.tab), visitor)).changes, undefined);
    assert.match(String((await readyOf(urls.events(owner.tab), owner)).changes), /^[\w-]+\.\d+$/);
  } finally {
    await instance.close();
  }
});

test("an API address spelled with escapes gets the API's headers", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "xena");
    // The router decodes %61 to "a", so this is the session route.
    const res = await owner.raw({ url: "/%61pi/session" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.match(String(res.headers[headers.changes.toLowerCase()]), /^[\w-]+\.\d+$/);
  } finally {
    await instance.close();
  }
});

test("the public health check names the build by its short commit", async () => {
  const instance = await start();
  const was = build.commit;
  try {
    build.commit = "0123456789abcdef0123456789abcdef01234567";
    const health = await new Client(instance).call(api.health);
    assert.equal(health.commit, "0123456");
    assert.equal(health.version, build.version);
    // Admin still has the whole of it.
    assert.equal((await (await admin(instance)).call(api.admin.overview)).build.commit, build.commit);
  } finally {
    build.commit = was;
    await instance.close();
  }
});

test("an address the router can't read gets a plain 400 that doesn't repeat it", async () => {
  const instance = await start({ origin: "https://relay.example" }, undefined, { setup: false });
  try {
    const secret = randomToken();
    for (const url of [`/s/${secret}%ff`, `/api/s/${secret}%`, `/api/r/${secret}${"x".repeat(100)}`]) {
      const res = await instance.app.inject({ url, headers: { host: "relay.example" } });
      assert.equal(res.statusCode, 400, url);
      assert.doesNotMatch(res.body, new RegExp(secret), "the address is never echoed back");
      assert.doesNotMatch(res.body, /FST_/);
      assert.equal(res.json<{ error: string }>().error, "That address isn't valid. Check the link and try again.");
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["strict-transport-security"], "max-age=31536000");
      assert.match(String(res.headers["content-security-policy"]), /frame-ancestors 'none'/);
    }
  } finally {
    await instance.close();
  }
});

test("Fetch Metadata saying cross-site is refused however it is written", async () => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    for (const site of ["Cross-Site", "same-origin, cross-site", " CROSS-SITE "]) {
      const res = await owner.raw({ method: "POST", url: api.admin.invite.path, headers: { "sec-fetch-site": site } });
      assert.equal(res.statusCode, 403, site);
    }
    const res = await owner.raw({
      method: "POST",
      url: api.admin.invite.path,
      headers: { "sec-fetch-site": "same-origin" },
    });
    assert.equal(res.statusCode, 200);
  } finally {
    await instance.close();
  }
});
