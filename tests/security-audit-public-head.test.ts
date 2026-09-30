// Public HEAD authorization verification, using only disposable Relay resources.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { request, type IncomingHttpHeaders } from "node:http";
import { setImmediate } from "node:timers/promises";
import sharp from "sharp";
import { api } from "../shared/api.ts";
import { Client, admin, member, send, start, type Instance } from "./support/harness.ts";

type Observed = { status: number; headers: IncomingHttpHeaders; body: string };
type Evidence = {
  route: string;
  case: string;
  actor: string;
  expected: number;
  head: number;
  get: number | null;
  bodyBytes: number;
  sensitiveHeaders: string[];
};
const evidence: Evidence[] = [];
const unsupported: Evidence[] = [];
// Enumerated from route-matrix.json; keep the regression runnable without ignored work artifacts.
const inventory = [
  "/api/health",
  "/api/session/device-link/:token",
  "/api/setup",
  "/api/s/:token",
  "/api/s/:token/nodes/:node/content",
  "/api/s/:token/nodes/:node/thumbnail",
  "/api/s/:token/zip",
  "/api/invitations/:token",
  "/api/r/:token",
  "/api/r/:token/events",
  "/api/n/:token",
  "/api/n/:token/events",
  "/api/pickup/config",
  "/uploads/:id",
];
const sensitive = ["content-disposition", "etag", "last-modified", "content-range", "upload-offset", "upload-length"];
after(async () => {
  await mkdir("work/security-audit", { recursive: true });
  await writeFile(
    "work/security-audit/public-head-runtime.json",
    JSON.stringify({ inventory, evidence, unsupported }, null, 2) + "\n",
  );
  assert.deepEqual(
    [...new Set(evidence.map((row) => row.route))].sort(),
    [...inventory].sort(),
    "every public/raw HEAD route in the matrix must be exercised",
  );
});
const pathOf = (route: string, values: Record<string, string>) =>
  Object.entries(values).reduce((path, [key, value]) => path.replace(`:${key}`, encodeURIComponent(value)), route);
const raw = async (client: Client, method: "GET" | "HEAD", path: string): Promise<Observed> => {
  if (method === "HEAD") {
    const address = client.instance.app.server.address();
    const base =
      address && typeof address === "object"
        ? `http://127.0.0.1:${address.port}`
        : await client.instance.app.listen({ port: 0, host: "127.0.0.1" });
    return network(base, client, method, path);
  }
  const response = await client.raw({ method, url: path });
  return { status: response.statusCode, headers: response.headers as IncomingHttpHeaders, body: response.body };
};

// Capture real streaming response headers, then destroy the request and await socket closure.
// The timeout also destroys a handler that never produces headers; inject is never used for SSE.
function network(base: string, client: Client, method: "GET" | "HEAD", path: string): Promise<Observed> {
  return new Promise((resolve, reject) => {
    let result: Observed | undefined;
    const cookie = [...client.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    const req = request(
      base + path,
      { method, agent: false, headers: { host: "relay.test", ...(cookie ? { cookie } : {}) } },
      (res) => {
        if (String(res.headers["content-type"]).startsWith("text/event-stream")) {
          result = { status: res.statusCode!, headers: res.headers, body: "" };
          res.destroy();
          req.destroy();
        } else {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => {
            result = { status: res.statusCode!, headers: res.headers, body };
            req.destroy();
          });
          res.on("error", reject);
        }
      },
    );
    const timeout = setTimeout(() => req.destroy(new Error(`Timed out at ${method} ${path}`)), 2000);
    req.on("error", (error) => {
      if (!result) reject(error);
    });
    req.on("close", () => {
      clearTimeout(timeout);
      if (result) resolve(result);
      else reject(new Error(`Closed without a response at ${method} ${path}`));
    });
    req.end();
  });
}
async function check(
  client: Client,
  route: string,
  values: Record<string, string>,
  expected: number,
  description: string,
  actor = "no-cookie bearer holder",
  base?: string,
) {
  const path = pathOf(route, values);
  const get = base ? await network(base, client, "GET", path) : await raw(client, "GET", path);
  if (base) await setImmediate();
  const head = base ? await network(base, client, "HEAD", path) : await raw(client, "HEAD", path);
  if (base) await setImmediate();
  const exposed = sensitive.filter((key) => head.headers[key] !== undefined);
  evidence.push({
    route,
    case: description,
    actor,
    expected,
    head: head.status,
    get: get.status,
    bodyBytes: Buffer.byteLength(head.body),
    sensitiveHeaders: exposed,
  });
  assert.equal(get.status, expected, `GET ${path}: ${get.body}`);
  assert.equal(head.status, expected, `HEAD ${path}: ${head.body}`);
  assert.equal(head.body, "", "HEAD must send no response payload");
  assert.equal(
    head.headers["content-type"],
    get.headers["content-type"],
    "HEAD content type must match GET authorization result",
  );
  if (expected >= 400) assert.deepEqual(exposed, [], "denied HEAD must not expose resource content/upload headers");
  return { get, head };
}
async function uploadHead(client: Client, id: string, expected: number, description: string, actor: string) {
  const response = await raw(client, "HEAD", `/uploads/${id}`);
  const exposed = sensitive.filter((key) => response.headers[key] !== undefined);
  evidence.push({
    route: "/uploads/:id",
    case: description,
    actor,
    expected,
    head: response.status,
    get: null,
    bodyBytes: Buffer.byteLength(response.body),
    sensitiveHeaders: exposed,
  });
  assert.equal(response.status, expected, JSON.stringify(response));
  assert.equal(response.body, "");
  if (expected >= 400) assert.deepEqual(exposed, []);
}
const invalid = "A".repeat(43);
const intake = (owner: Client, name: string) =>
  owner.call(api.requests.create, {
    body: { id: crypto.randomUUID(), name, description: "Disposable private intake", days: 1, maxBytes: 100 },
  });
async function requestGuest(instance: Instance, token: string) {
  const guest = new Client(instance);
  await guest.call(api.requests.start, { params: { token } });
  return guest;
}

test("public HEAD: share metadata/content/thumbnail/zip retain bearer and resource scope", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "head-share-owner");
    const stranger = await member(instance, "head-share-stranger");
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } })
      .png()
      .toBuffer();
    const first = await send(owner, [{ path: "First/image.png", data: image, mime: "image/png" }], {
      destination: { kind: "link", days: 1 },
    });
    const second = await send(stranger, [{ path: "Second/image.png", data: image, mime: "image/png" }], {
      destination: { kind: "link", days: 1 },
    });
    const firstDetail = await owner.call(api.items.get, { params: { id: first.result.itemId } });
    const secondDetail = await stranger.call(api.items.get, { params: { id: second.result.itemId } });
    const node = firstDetail.nodes.find((value) => value.kind === "file")!.id;
    const foreignNode = secondDetail.nodes.find((value) => value.kind === "file")!.id;
    const foreignFolder = secondDetail.nodes.find((value) => value.kind === "folder")!.id;
    const token = first.result.link!.token;
    const visitor = new Client(instance);
    const routes = [
      "/api/s/:token",
      "/api/s/:token/nodes/:node/content",
      "/api/s/:token/nodes/:node/thumbnail",
      "/api/s/:token/zip",
    ];
    for (const route of routes) {
      await check(visitor, route, { token, node }, 200, "valid resource");
      await check(visitor, route, { token: invalid, node }, 404, "invalid bearer");
    }
    for (const route of routes.slice(1, 3))
      await check(visitor, route, { token, node: foreignNode }, 404, "valid share bearer with foreign node");
    const foreignZip = await raw(visitor, "HEAD", `/api/s/${token}/zip?folder=${foreignFolder}`);
    const foreignZipGet = await raw(visitor, "GET", `/api/s/${token}/zip?folder=${foreignFolder}`);
    evidence.push({
      route: "/api/s/:token/zip",
      case: "foreign folder",
      actor: "share holder",
      expected: 404,
      head: foreignZip.status,
      get: foreignZipGet.status,
      bodyBytes: Buffer.byteLength(foreignZip.body),
      sensitiveHeaders: sensitive.filter((key) => foreignZip.headers[key] !== undefined),
    });
    assert.equal(foreignZip.status, 404);
    assert.equal(foreignZipGet.status, 404);
    assert.equal(foreignZip.body, "");
    assert.deepEqual(
      sensitive.filter((key) => foreignZip.headers[key] !== undefined),
      [],
    );
    const locked = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: first.result.itemId, days: 1, password: "Locked-share-password" },
    });
    const noUnlock = new Client(instance);
    await check(noUnlock, routes[0], { token: locked.token }, 200, "locked share exposes only allowed lock metadata");
    for (const route of routes.slice(1))
      await check(noUnlock, route, { token: locked.token, node }, 401, "locked content cannot be served");
    instance.ctx.db.run("UPDATE links SET expires = ? WHERE id = ?", Date.now() - 1, first.result.link!.id);
    for (const route of routes)
      await check(
        visitor,
        route,
        { token, node },
        404,
        "expired bearer even with existing visitor cookie",
        "visitor-cookie holder",
      );
    await owner.call(api.links.revoke, { params: { id: locked.id } });
    for (const route of routes) await check(noUnlock, route, { token: locked.token, node }, 404, "revoked bearer");
  } finally {
    await instance.close();
  }
});

test("public HEAD: request metadata and streaming HEAD respect request/grant scope", async () => {
  const instance = await start();
  try {
    const base = await instance.app.listen({ port: 0, host: "127.0.0.1" });
    const owner = await member(instance, "head-request-owner");
    const first = await intake(owner, "First request");
    const second = await intake(owner, "Second request");
    const guest = await requestGuest(instance, first.token);
    const otherGuest = await requestGuest(instance, second.token);
    const anonymous = new Client(instance);
    for (const client of [anonymous, guest, otherGuest])
      await check(
        client,
        "/api/r/:token",
        { token: first.token },
        200,
        "valid public request metadata",
        client === anonymous ? "no-cookie" : client === guest ? "same request guest" : "foreign request guest",
      );
    await check(
      anonymous,
      "/api/r/:token/events",
      { token: first.token },
      401,
      "valid request bearer without a grant",
      "no-cookie",
      base,
    );
    await check(
      guest,
      "/api/r/:token/events",
      { token: first.token },
      200,
      "matching request grant",
      "same request guest",
      base,
    );
    await check(
      otherGuest,
      "/api/r/:token/events",
      { token: first.token },
      401,
      "foreign request cookie cannot scope stream",
      "foreign request guest",
      base,
    );
    for (const route of ["/api/r/:token", "/api/r/:token/events"])
      await check(
        guest,
        route,
        { token: invalid },
        404,
        "invalid resource token with a valid unrelated grant",
        "request guest",
        route.endsWith("events") ? base : undefined,
      );
    const upload = await guest.call(api.requests.transfer, {
      params: { token: first.token },
      body: {
        id: crypto.randomUUID(),
        tab: guest.tab,
        folders: [],
        files: [{ path: "pending.txt", size: 4, mime: "text/plain" }],
      },
    });
    await uploadHead(guest, upload.uploads[0].id, 200, "matching grant owns the upload", "request guest");
    await uploadHead(anonymous, upload.uploads[0].id, 401, "no upload credential", "no-cookie");
    await uploadHead(
      otherGuest,
      upload.uploads[0].id,
      404,
      "foreign grant cannot inspect upload offset/length",
      "foreign request guest",
    );
    await uploadHead(guest, crypto.randomUUID(), 404, "invalid upload identifier", "request guest");
    instance.ctx.db.run("UPDATE guest_grants SET expires = ? WHERE request_id = ?", Date.now() - 1, first.id);
    await check(
      guest,
      "/api/r/:token",
      { token: first.token },
      200,
      "expired grant does not hide public request metadata",
      "expired request guest",
    );
    await check(
      guest,
      "/api/r/:token/events",
      { token: first.token },
      401,
      "expired grant cannot open stream",
      "expired request guest",
      base,
    );
    await uploadHead(guest, upload.uploads[0].id, 401, "expired grant cannot inspect upload", "expired request guest");
    instance.ctx.db.run("UPDATE requests SET expires = ? WHERE id = ?", Date.now() - 1, first.id);
    await check(guest, "/api/r/:token", { token: first.token }, 410, "expired request", "old request guest");
    await check(
      guest,
      "/api/r/:token/events",
      { token: first.token },
      401,
      "expired request invalidates grant",
      "old request guest",
      base,
    );
    await owner.call(api.requests.close, { params: { id: second.id } });
    await check(otherGuest, "/api/r/:token", { token: second.token }, 410, "closed request", "revoked request guest");
    await check(
      otherGuest,
      "/api/r/:token/events",
      { token: second.token },
      401,
      "closed request invalidates guest stream",
      "revoked request guest",
      base,
    );
  } finally {
    await instance.close();
  }
});

test("public HEAD: Nearby metadata and streaming HEAD respect code and guest scope", async () => {
  const instance = await start();
  try {
    const base = await instance.app.listen({ port: 0, host: "127.0.0.1" });
    const firstOwner = await member(instance, "head-nearby-first");
    const secondOwner = await member(instance, "head-nearby-second");
    const first = await firstOwner.call(api.nearby.invite);
    const second = await secondOwner.call(api.nearby.invite);
    const guest = new Client(instance);
    const foreign = new Client(instance);
    const anonymous = new Client(instance);
    const joined = await guest.call(api.nearby.join, {
      params: { token: first.token },
      body: { name: "First guest", kind: "computer" },
    });
    await foreign.call(api.nearby.join, {
      params: { token: second.token },
      body: { name: "Second guest", kind: "computer" },
    });
    for (const client of [anonymous, guest, foreign]) {
      const result = await check(
        client,
        "/api/n/:token",
        { token: first.token },
        200,
        "valid public Nearby metadata",
        client === anonymous ? "no-cookie" : client === guest ? "same code guest" : "foreign code guest",
      );
      if (client !== guest) {
        const body = JSON.parse(result.get.body) as { self: unknown; peers: unknown[] };
        assert.equal(body.self, null);
        assert.deepEqual(body.peers, []);
      }
    }
    await check(
      anonymous,
      "/api/n/:token/events",
      { token: first.token },
      401,
      "code holder without guest cookie",
      "no-cookie",
      base,
    );
    await check(
      guest,
      "/api/n/:token/events",
      { token: first.token },
      200,
      "matching Nearby guest",
      "same code guest",
      base,
    );
    await check(
      foreign,
      "/api/n/:token/events",
      { token: first.token },
      401,
      "foreign cookie cannot open another code's stream",
      "foreign code guest",
      base,
    );
    for (const route of ["/api/n/:token", "/api/n/:token/events"])
      await check(
        guest,
        route,
        { token: invalid },
        404,
        "invalid token with a valid unrelated guest cookie",
        "Nearby guest",
        route.endsWith("events") ? base : undefined,
      );
    await firstOwner.call(api.nearby.removeGuest, { params: { id: joined.self!.id } });
    await check(
      guest,
      "/api/n/:token",
      { token: first.token },
      200,
      "revoked guest still sees only public code state",
      "revoked code guest",
    );
    await check(
      guest,
      "/api/n/:token/events",
      { token: first.token },
      401,
      "revoked guest cannot open stream",
      "revoked code guest",
      base,
    );
    instance.ctx.db.run("UPDATE nearby_invites SET expires = ? WHERE id = ?", Date.now() - 1, first.id);
    for (const route of ["/api/n/:token", "/api/n/:token/events"])
      await check(
        guest,
        route,
        { token: first.token },
        410,
        "expired Nearby code",
        "old code guest",
        route.endsWith("events") ? base : undefined,
      );
    await secondOwner.call(api.nearby.endInvite);
    for (const route of ["/api/n/:token", "/api/n/:token/events"])
      await check(
        foreign,
        route,
        { token: second.token },
        404,
        "ended/deleted Nearby code",
        "ended code guest",
        route.endsWith("events") ? base : undefined,
      );
  } finally {
    await instance.close();
  }
});

test("public HEAD: invitations reject invalid, expired, withdrawn and consumed tokens", async () => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    const anonymous = new Client(instance);
    const issued = await owner.call(api.admin.invite, { body: { note: "HEAD invitation" } });
    const invitation = (await owner.call(api.admin.invites)).find((value) => value.note === "HEAD invitation")!;
    const route = "/api/invitations/:token";
    await check(anonymous, route, { token: issued.token }, 200, "valid invitation");
    await check(anonymous, route, { token: invalid }, 410, "invalid invitation");
    instance.ctx.db.run("UPDATE invites SET expires = ? WHERE id = ?", Date.now() - 1, invitation.id);
    await check(anonymous, route, { token: issued.token }, 410, "expired invitation");
    const withdrawn = await owner.call(api.admin.invite, { body: { note: "Withdrawn HEAD invitation" } });
    const withdrawnId = (await owner.call(api.admin.invites)).find(
      (value) => value.note === "Withdrawn HEAD invitation",
    )!.id;
    await owner.call(api.admin.revokeInvite, { params: { id: withdrawnId } });
    await check(anonymous, route, { token: withdrawn.token }, 410, "withdrawn invitation");
    const consumed = await owner.call(api.admin.invite);
    await new Client(instance).call(api.session.join, {
      body: {
        token: consumed.token,
        username: "head-joined",
        password: "Head-join-password",
        deviceName: "Disposable",
      },
    });
    await check(anonymous, route, { token: consumed.token }, 410, "consumed invitation");
  } finally {
    await instance.close();
  }
});

test("public HEAD: device admission links reject invalid, expired, revoked and session-ended tokens", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "head-device-owner");
    const anonymous = new Client(instance);
    const route = "/api/session/device-link/:token";
    const first = await owner.call(api.loginCodes.create);
    await check(anonymous, route, { token: first.token }, 200, "valid admission bearer");
    await check(anonymous, route, { token: invalid }, 410, "invalid admission bearer");
    instance.ctx.db.run("UPDATE login_codes SET expires = ? WHERE id = ?", Date.now() - 1, first.id);
    await check(anonymous, route, { token: first.token }, 410, "expired admission bearer");
    const revoked = await owner.call(api.loginCodes.create);
    await owner.call(api.loginCodes.revoke, { params: { id: revoked.id } });
    await check(anonymous, route, { token: revoked.token }, 410, "revoked admission bearer");
    const ended = await owner.call(api.loginCodes.create);
    await owner.call(api.session.signOut);
    await check(anonymous, route, { token: ended.token }, 410, "issuing session ended");
  } finally {
    await instance.close();
  }
});

test("public HEAD: non-bearer public metadata and unsupported pickup HEAD paths preserve GET policy", async () => {
  const instance = await start();
  try {
    const anonymous = new Client(instance);
    for (const route of ["/api/health", "/api/setup", "/api/pickup/config"])
      await check(anonymous, route, {}, 200, "public static metadata");
    for (const path of ["/api/pickup", "/api/pickup/000000"]) {
      const head = await raw(anonymous, "HEAD", path);
      const get = await raw(anonymous, "GET", path);
      assert.equal(head.status, 404);
      assert.equal(get.status, 404);
      assert.equal(head.body, "");
      unsupported.push({
        route: path,
        case: "pickup has no GET/HEAD resolver",
        actor: "no-cookie",
        expected: 404,
        head: head.status,
        get: get.status,
        bodyBytes: Buffer.byteLength(head.body),
        sensitiveHeaders: sensitive.filter((key) => head.headers[key] !== undefined),
      });
      assert.deepEqual(unsupported.at(-1)!.sensitiveHeaders, []);
    }
  } finally {
    await instance.close();
  }
});
