// Independent adversarial audit cases. Instances and keys are disposable; no deployed data is used.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { createSocket } from "node:dgram";
import { api, urls, type Endpoint } from "../shared/api.ts";
import { LOCAL_TOKEN_HEADER, SOCKETS } from "../shared/local.ts";
import { sha256 } from "../server/lib/secrets.ts";
import { Client, admin, member, start, ADMIN_PASSWORD } from "./support/harness.ts";
import { listen, Stream } from "./support/event-stream.ts";

type Evidence = {
  endpoint: string;
  actor: string;
  attack: string;
  observed: string;
  test: string;
  classification: string;
};
const evidence: Evidence[] = [];
const testPath = "tests/security-audit-auth-direct.test.ts";
function record(endpoint: string, actor: string, attack: string, observed: string | number) {
  evidence.push({ endpoint, actor, attack, observed: String(observed), test: testPath, classification: "attacked" });
}
async function raw(
  client: Client,
  endpoint: Endpoint,
  payload?: object,
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  let url = endpoint.path;
  for (const [key, value] of Object.entries(params)) url = url.replace(`:${key}`, encodeURIComponent(value));
  return client.raw({ method: endpoint.method, url, ...(payload ? { payload } : {}), headers });
}
const sid = (client: Client) => sha256([...client.cookies.values()][0]);
after(async () => {
  await mkdir("work/security-audit", { recursive: true });
  await writeFile("work/security-audit/auth-direct-runtime.json", JSON.stringify(evidence, null, 2) + "\n");
});

test("audit auth: every member/admin contract rejects anonymous and foreign administrator access", async () => {
  const instance = await start();
  try {
    const anon = new Client(instance);
    const user = await member(instance, "audit-member");
    const id = crypto.randomUUID();
    for (const [group, endpoints] of Object.entries({
      session: api.session,
      account: api.account,
      devices: api.devices,
      loginCodes: api.loginCodes,
      admin: api.admin,
      setup: api.setup,
      local: api.local,
      nearby: api.nearby,
    })) {
      for (const [key, endpoint] of Object.entries(endpoints) as [string, Endpoint][]) {
        if (endpoint.auth !== "member" && endpoint.auth !== "admin") continue;
        const denied = await raw(anon, endpoint, {}, { id });
        assert.equal(denied.statusCode, 401, `${group}.${key} must authenticate before parsing`);
        record(`${endpoint.method} ${endpoint.path}`, "anonymous", "invoke protected endpoint", denied.statusCode);
        if (endpoint.auth === "admin") {
          const foreign = await raw(user, endpoint, {}, { id });
          assert.equal(foreign.statusCode, 403, `${group}.${key} requires administrator`);
          record(`${endpoint.method} ${endpoint.path}`, "member", "administrator role escalation", foreign.statusCode);
        }
      }
    }
    for (const path of ["/api/events", `/api/r/${"A".repeat(43)}/events`, `/api/n/${"A".repeat(43)}/events`]) {
      const response = await anon.raw({ method: "GET", url: path });
      assert.ok([401, 404].includes(response.statusCode));
      record(`GET ${path.replace(/A{43}/, ":token")}`, "anonymous", "open private event stream", response.statusCode);
    }
    const me = await user.call(api.session.get);
    assert.equal(me.user.username, "audit-member");
    record("GET /api/session", "member", "allowed session control", "200; own account only");
  } finally {
    await instance.close();
  }
});

test("audit auth: origin, CSRF and session cookies block ambient-credential changes", async () => {
  const instance = await start({ origin: "https://relay.test" });
  try {
    const user = await member(instance, "csrf-audit");
    const adminClient = await admin(instance);
    for (const client of [user, adminClient]) {
      const cookieName = [...client.cookies.keys()][0];
      assert.equal(cookieName, "__Host-relay");
      const before = client.csrf;
      client.csrf = "";
      const denied = await raw(client, api.account.update, { name: "forged" });
      assert.equal(denied.statusCode, 403);
      client.csrf = before;
      record("PATCH /api/account", "authenticated browser", "missing CSRF", denied.statusCode);
      const wrongOrigin = await raw(
        client,
        api.account.update,
        { name: "forged" },
        {},
        { origin: "https://evil.example" },
      );
      assert.equal(wrongOrigin.statusCode, 403);
      record("PATCH /api/account", "authenticated browser", "cross-origin with valid CSRF", wrongOrigin.statusCode);
      const wrongMetadata = await raw(
        client,
        api.account.update,
        { name: "forged" },
        {},
        { "sec-fetch-site": "cross-site" },
      );
      assert.equal(wrongMetadata.statusCode, 403);
      record("PATCH /api/account", "authenticated browser", "cross-site Fetch Metadata", wrongMetadata.statusCode);
      assert.equal(
        (await raw(client, api.account.update, { name: "allowed" }, {}, { origin: "https://relay.test" })).statusCode,
        200,
      );
    }
    const login = new Client(instance);
    const signedIn = await raw(login, api.session.password, { username: "admin", password: ADMIN_PASSWORD });
    assert.equal(signedIn.statusCode, 200);
    const cookie = signedIn.headers["set-cookie"] as string;
    assert.match(cookie, /__Host-relay=.*; Max-Age=.*; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    const publicWrites: [Endpoint, object][] = [
      [api.session.password, { username: "admin", password: ADMIN_PASSWORD }],
      [api.session.passkeyOptions, {}],
      [api.session.passkey, { challenge: "bogus", response: {} }],
      [api.session.code, { code: "0000", deviceName: "attack" }],
      [api.session.deviceLink, { token: "bogus", deviceName: "attack" }],
      [api.session.join, { token: "bogus", username: "attacker", password: "Attacker-password-only" }],
      [api.setup.account, { username: "attacker", password: "Attacker-password-only" }],
    ];
    for (const [endpoint, body] of publicWrites) {
      const denied = await raw(new Client(instance), endpoint, body, {}, { origin: "https://evil.example" });
      assert.equal(denied.statusCode, 403);
      record(
        `${endpoint.method} ${endpoint.path}`,
        "cross-site anonymous browser",
        "login/setup CSRF",
        denied.statusCode,
      );
    }
  } finally {
    await instance.close();
  }
});

test("audit auth: invitation and device capabilities are single-use, owned and session-bound", async () => {
  const instance = await start();
  try {
    const a = await admin(instance);
    const invite = await a.call(api.admin.invite, { body: { note: "audit" } });
    const pending = await a.call(api.admin.invites);
    const invitationId = pending.find((i) => i.note === "audit")!.id;
    const anonymous = new Client(instance);
    assert.equal((await raw(anonymous, api.session.invitation, undefined, { token: invite.token })).statusCode, 200);
    await a.call(api.admin.updateInvite, { params: { id: invitationId }, body: { note: "updated" } });
    const payload = {
      token: invite.token,
      username: "cap-audit",
      password: "Member-password-only",
      deviceName: "Owner",
    };
    const [one, two] = await Promise.all([
      raw(anonymous, api.session.join, payload),
      raw(new Client(instance), api.session.join, { ...payload, username: "cap-other" }),
    ]);
    assert.deepEqual([one.statusCode, two.statusCode].sort(), [200, 410]);
    record("POST /api/session/join", "two bearer holders", "concurrent invitation replay", "200 once, 410 replay");
    const user = one.statusCode === 200 ? anonymous : await member(instance, "replacement-audit", a);
    user.csrf = (await user.call(api.session.get)).csrf;
    const foreign = await member(instance, "foreign-audit", a);
    const code = await user.call(api.loginCodes.create);
    assert.equal((await raw(foreign, api.loginCodes.revoke, undefined, { id: code.id })).statusCode, 404);
    assert.deepEqual(await foreign.call(api.loginCodes.status, { params: { id: code.id } }), { state: "gone" });
    const foreignDevice = (await foreign.call(api.session.get)).device.id;
    for (const endpoint of [api.devices.update, api.devices.signOut]) {
      const denied = await raw(user, endpoint, endpoint.method === "PATCH" ? { name: "stolen" } : undefined, {
        id: foreignDevice,
      });
      assert.equal(denied.statusCode, 404);
      record(`${endpoint.method} ${endpoint.path}`, "foreign member", "cross-account device ID", denied.statusCode);
    }
    assert.equal(
      (await raw(new Client(instance), api.session.deviceLinkCheck, undefined, { token: code.token })).statusCode,
      200,
    );
    const browser1 = new Client(instance),
      browser2 = new Client(instance);
    const linkBody = { token: code.token, deviceName: "New device" };
    const redeemed = await Promise.all([
      raw(browser1, api.session.deviceLink, linkBody),
      raw(browser2, api.session.deviceLink, linkBody),
    ]);
    assert.deepEqual(redeemed.map((r) => r.statusCode).sort(), [200, 410]);
    record(
      "POST /api/session/device-link",
      "two bearer holders",
      "concurrent device-link replay",
      "200 once, 410 replay",
    );
    const next = await user.call(api.loginCodes.create);
    await user.call(api.loginCodes.revoke, { params: { id: next.id } });
    assert.equal(
      (await raw(new Client(instance), api.session.code, { code: next.code, deviceName: "attack" })).statusCode,
      410,
    );
    record("POST /api/session/code", "revoked numeric-code holder", "redeem revoked code", 410);
    const bound = await user.call(api.loginCodes.create);
    await user.call(api.session.signOut);
    assert.equal(
      (await raw(new Client(instance), api.session.deviceLink, { token: bound.token, deviceName: "attack" }))
        .statusCode,
      410,
    );
    record("POST /api/session/device-link", "old bearer holder", "redeem after issuer sign-out", 410);
    const unused = await a.call(api.admin.invite, { body: { note: "revoke-audit" } });
    const unusedId = (await a.call(api.admin.invites)).find((i) => i.note === "revoke-audit")!.id;
    await a.call(api.admin.revokeInvite, { params: { id: unusedId } });
    assert.equal(
      (await raw(new Client(instance), api.session.invitation, undefined, { token: unused.token })).statusCode,
      410,
    );
    record("GET /api/invitations/:token", "revoked bearer holder", "inspect withdrawn invitation", 410);
  } finally {
    await instance.close();
  }
});

test("audit auth: suspension, reset and password changes revoke sessions, codes and live streams", async () => {
  const instance = await start();
  const streams: Stream[] = [];
  try {
    const base = await listen(instance);
    const a = await admin(instance);
    const owner = await member(instance, "revocation-audit", a);
    const other = new Client(instance);
    await other.signIn("revocation-audit", "Member-password-only", "Other browser");
    const userId = (await owner.call(api.session.get)).user.id;
    const live = await Stream.open(base, urls.events(other.tab), other);
    streams.push(live);
    await live.until((events) => events.some((e) => e.startsWith("event: ready")));
    const oldCode = await other.call(api.loginCodes.create);
    await owner.call(api.account.password, {
      body: { current: "Member-password-only", password: "Updated-member-password" },
    });
    assert.equal((await raw(other, api.session.get)).statusCode, 401);
    await live.until((events) => events.includes("<closed>"));
    assert.ok(live.events.some((e) => e.includes('"password-changed"')));
    assert.equal(
      (await raw(new Client(instance), api.session.deviceLink, { token: oldCode.token, deviceName: "attack" }))
        .statusCode,
      410,
    );
    record(
      "POST /api/account/password",
      "owner; revoked other browser",
      "keep prior session/code/SSE",
      "owner 200, old session 401, old code 410, SSE ended password-changed",
    );
    const ownerCode = await owner.call(api.loginCodes.create);
    await a.call(api.admin.updateMember, { params: { id: userId }, body: { disabled: true } });
    assert.equal((await raw(owner, api.session.get)).statusCode, 401);
    assert.equal(
      (await raw(new Client(instance), api.session.deviceLink, { token: ownerCode.token, deviceName: "attack" }))
        .statusCode,
      410,
    );
    assert.equal(
      (
        await raw(new Client(instance), api.session.password, {
          username: "revocation-audit",
          password: "Updated-member-password",
        })
      ).statusCode,
      403,
    );
    record(
      "PATCH /api/admin/members/:id",
      "suspended member",
      "continue session/login/code after disable",
      "old session 401, code 410, password login 403",
    );
    await a.call(api.admin.updateMember, { params: { id: userId }, body: { disabled: false } });
    const resetVictim = new Client(instance);
    await resetVictim.signIn("revocation-audit", "Updated-member-password");
    await a.call(api.admin.resetPassword, { params: { id: userId }, body: { password: "Admin-reset-password" } });
    assert.equal((await raw(resetVictim, api.session.get)).statusCode, 401);
    assert.equal(
      (
        await raw(new Client(instance), api.session.password, {
          username: "revocation-audit",
          password: "Updated-member-password",
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await raw(new Client(instance), api.session.password, {
          username: "revocation-audit",
          password: "Admin-reset-password",
        })
      ).statusCode,
      200,
    );
    record(
      "POST /api/admin/members/:id/password",
      "reset member",
      "continue old session/password",
      "session 401, old password 401, new password 200",
    );
  } finally {
    await Promise.all(streams.map((s) => s.close()));
    await instance.close();
  }
});

test("audit setup: key confidentiality, wrong-key rejection and racing first administrators", async () => {
  const instance = await start({ setupKey: true }, undefined, { setup: false });
  try {
    const anon = new Client(instance);
    const key = (await readFile(join(instance.root, "setup.key"), "utf8")).trim();
    assert.equal((await stat(join(instance.root, "setup.key"))).mode & 0o777, 0o600);
    const status = await raw(anon, api.setup.status);
    assert.equal(status.statusCode, 200);
    assert.ok(!status.body.includes(key));
    const body = { username: "initial", password: ADMIN_PASSWORD };
    assert.equal((await raw(anon, api.setup.account, body)).statusCode, 403);
    assert.equal((await raw(anon, api.setup.account, { ...body, setupKey: "wrong" })).statusCode, 403);
    const other = new Client(instance);
    const race = await Promise.all([
      raw(anon, api.setup.account, { ...body, setupKey: key }),
      raw(other, api.setup.account, { ...body, username: "racer", setupKey: key }),
    ]);
    assert.deepEqual(race.map((r) => r.statusCode).sort(), [200, 409]);
    record(
      "POST /api/setup/account",
      "two setup-key holders",
      "race first administrator creation",
      "200 once, 409 rival; missing/wrong key 403; key file 0600",
    );
    const winner = race[0].statusCode === 200 ? anon : other;
    await winner.call(api.session.get);
    assert.equal((await raw(winner, api.setup.finish, { capacity: 1024 ** 3 })).statusCode, 200);
    assert.equal((await raw(winner, api.setup.finish, { capacity: 1024 ** 3 })).statusCode, 409);
    record("POST /api/setup/finish", "administrator", "repeat final setup", "200 allowed; 409 repeat");
    record("GET /api/setup", "anonymous", "retrieve setup secret", "200 state only; key absent");
  } finally {
    await instance.close();
  }
});

test("audit Nearby: SSE identity, guest ownership, CSRF, network visibility, signaling bounds and revocation", async () => {
  const instance = await start();
  const open: Stream[] = [];
  try {
    const base = await listen(instance);
    const owner = await member(instance, "nearby-owner");
    const foreign = await member(instance, "nearby-foreign");
    const ownerId = (await owner.call(api.session.get)).device.id;
    const foreignId = (await foreign.call(api.session.get)).device.id;
    const presence = async (client: Client) => {
      const stream = await Stream.open(base, urls.events(client.tab), client);
      open.push(stream);
      await stream.until((events) => events.some((e) => e.startsWith("event: ready")));
      await client.call(api.nearby.present, { body: { tab: client.tab } });
      return stream;
    };
    const ownerStream = await presence(owner);
    const foreignStream = await presence(foreign);
    assert.equal((await raw(foreign, api.nearby.present, { tab: owner.tab })).statusCode, 409);
    record("POST /api/nearby/presence", "foreign member", "register through another session's stream/tab", 409);
    const signal = {
      kind: "offer",
      session: "audit-session",
      sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
    };
    assert.equal((await raw(owner, api.nearby.signal, { to: foreignId, signal })).statusCode, 200);
    await foreignStream.until((events) => events.some((e) => e.includes('"from":"' + ownerId + '"')));
    await foreign.call(api.account.update, { body: { prefs: { nearbyVisible: false } } });
    assert.equal((await raw(owner, api.nearby.signal, { to: foreignId, signal })).statusCode, 404);
    await foreign.call(api.account.update, { body: { prefs: { nearbyVisible: true } } });
    foreign.address = "203.0.113.20";
    await foreign.call(api.nearby.present, { body: { tab: foreign.tab } });
    assert.equal((await raw(owner, api.nearby.signal, { to: foreignId, signal })).statusCode, 404);
    record(
      "POST /api/nearby/signal",
      "other member",
      "send after hidden/different-network state",
      "200 same local network; 404 hidden; 404 remote network",
    );
    const invite = await owner.call(api.nearby.invite);
    assert.equal((await owner.call(api.nearby.extendInvite)).id, invite.id);
    const guest = new Client(instance);
    const noCookie = await guest.call(api.nearby.guest, { params: { token: invite.token } });
    assert.equal(noCookie.self, null);
    assert.deepEqual(noCookie.peers, []);
    const joined = await guest.call(api.nearby.join, {
      params: { token: invite.token },
      body: { name: "Guest", kind: "computer" },
    });
    assert.ok(joined.self);
    const guestId = joined.self.id;
    const guestStream = await Stream.open(base, urls.nearbyEvents(invite.token), guest);
    open.push(guestStream);
    await guestStream.until((events) => events.some((e) => e.startsWith("event: ready")));
    const body = { to: ownerId, signal };
    assert.equal((await raw(guest, api.nearby.guestSignal, body, { token: invite.token })).statusCode, 403);
    guest.csrf = joined.self.csrf;
    assert.equal(
      (await raw(guest, api.nearby.guestSignal, body, { token: invite.token }, { origin: "http://evil.example" }))
        .statusCode,
      403,
    );
    assert.equal((await raw(guest, api.nearby.guestSignal, body, { token: invite.token })).statusCode, 200);
    await ownerStream.until((events) => events.some((e) => e.includes('"from":"' + guestId + '"')));
    assert.equal(
      (await raw(guest, api.nearby.guestSignal, { to: foreignId, signal }, { token: invite.token })).statusCode,
      404,
    );
    assert.equal(
      (
        await raw(
          guest,
          api.nearby.guestSignal,
          { ...body, signal: { ...signal, sdp: "x".repeat(16385) } },
          { token: invite.token },
        )
      ).statusCode,
      400,
    );
    assert.equal((await raw(foreign, api.nearby.removeGuest, undefined, { id: guestId })).statusCode, 404);
    record(
      "POST /api/n/:token/signal",
      "guest",
      "wrong CSRF/origin/foreign host/oversize SDP",
      "403 missing CSRF; 403 cross-origin; 404 foreign host; 400 16385-char SDP; 200 allowed signal",
    );
    record(
      "GET /api/n/:token",
      "unjoined bearer holder",
      "enumerate host devices without guest cookie",
      "200; no identity or peers",
    );
    record(
      "POST /api/n/:token/join",
      "Nearby bearer holder",
      "allowed guest admission",
      "200; random guest cookie and CSRF",
    );
    await owner.call(api.nearby.removeGuest, { params: { id: guestId } });
    await guestStream.until((events) => events.includes("<closed>"));
    assert.equal((await raw(guest, api.nearby.guestSignal, body, { token: invite.token })).statusCode, 401);
    record(
      "DELETE /api/nearby/guests/:id",
      "owner and foreign member",
      "remove guest; signal with revoked cookie",
      "foreign 404; owner 200; SSE closed; revoked guest 401",
    );
    const rejoined = await guest.call(api.nearby.join, {
      params: { token: invite.token },
      body: { name: "Guest again", kind: "phone" },
    });
    guest.csrf = rejoined.self!.csrf;
    assert.equal((await raw(guest, api.nearby.leave, undefined, { token: invite.token })).statusCode, 200);
    assert.equal((await raw(guest, api.nearby.leave, undefined, { token: invite.token })).statusCode, 401);
    record("DELETE /api/n/:token/join", "guest", "reuse leave credential", "200 allowed; 401 replay");
    await owner.call(api.nearby.endInvite);
    assert.equal((await raw(guest, api.nearby.guest, undefined, { token: invite.token })).statusCode, 404);
    record("DELETE /api/nearby/invite", "owner; ended bearer holder", "reopen ended code", "owner 200; old token 404");
    record("POST /api/nearby/invite", "member", "allowed invitation issuance", "200; same invite reused while live");
    record("PATCH /api/nearby/invite", "member", "allowed lifetime extension", "200; own invite only");
    record("GET /api/nearby", "member", "allowed directory", "200; own/authorized present peers only");
  } finally {
    await Promise.all(open.map((s) => s.close()));
    await instance.close();
  }
});

function socketRequest(
  dir: string,
  method: string,
  path: string,
  token?: string,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        socketPath: join(dir, SOCKETS.relay),
        method,
        path,
        headers: { ...headers, ...(token ? { [LOCAL_TOKEN_HEADER]: token } : {}) },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += String(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
test("audit Direct: real Unix socket rejects browser-forged headers and nonbulk routes; revocation remains enforced", async () => {
  const udp = createSocket("udp4");
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const port = (udp.address() as { port: number }).port;
  await new Promise<void>((resolve) => udp.close(() => resolve()));
  const instance = await start({ local: { port } });
  try {
    await instance.app.ready();
    const client = await member(instance, "direct-audit");
    const token = instance.ctx.secrets.localToken(sid(client));
    const dir = instance.ctx.local!.dir!;
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, SOCKETS.relay))).mode & 0o777, 0o600);
    assert.equal((await socketRequest(dir, "GET", "/api/local/check")).status, 421);
    assert.equal((await socketRequest(dir, "GET", "/api/local/check", token + "bad")).status, 421);
    assert.equal((await socketRequest(dir, "GET", "/api/local/check", token)).status, 200);
    for (const path of [
      "/api/session",
      "/api/admin",
      "/api/local/check?x=1",
      "/api/local/check/",
      "/api/local/../admin",
      "http://relay.test/api/local/check",
    ]) {
      const response = await socketRequest(dir, "GET", path, token);
      assert.equal(response.status, 404, path);
    }
    assert.equal((await socketRequest(dir, "DELETE", "/api/local/check", token)).status, 404);
    const external = await client.raw({
      method: "GET",
      url: "/api/local/check",
      headers: { [LOCAL_TOKEN_HEADER]: token },
    });
    assert.equal(external.statusCode, 404);
    record(
      "GET /api/local/check",
      "network browser/Unix-socket caller",
      "forge local identity; missing/tampered token; route confusion",
      "external forged header 404; no/bad MAC 421; valid MAC 200; nonbulk paths/methods 404; dir 0700, socket 0600",
    );
    await client.call(api.session.signOut);
    assert.equal((await socketRequest(dir, "GET", "/api/local/check", token)).status, 401);
    record("GET /api/local/check", "revoked Direct connection", "keep old session HMAC", 401);
    record("POST /api/local/connect", "anonymous", "establish helper connection without session", 401);
  } finally {
    await instance.close();
  }
});
