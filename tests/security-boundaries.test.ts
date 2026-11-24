import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { start, type Instance } from "./support/harness.ts";
import { configFromEnv } from "../server/config.ts";
import { ProxyTrust } from "../server/lib/proxies.ts";
import { api } from "../shared/api.ts";

test("unconfigured hosts cannot rebind a browser to Relay", async () => {
  const instance = await start({ origin: undefined }, undefined, { setup: false });
  try {
    for (const host of [
      "attacker.example",
      "localhost.attacker.example",
      "localhost@attacker.example",
      "localhost/path",
    ])
      assert.equal((await instance.app.inject({ url: api.setup.status.path, headers: { host } })).statusCode, 403);
    for (const host of ["localhost", "localhost:3090", "127.0.0.1:3090", "[::1]:3090", "192.168.1.20:3090"])
      assert.equal((await instance.app.inject({ url: api.setup.status.path, headers: { host } })).statusCode, 200);
    const rejected = await instance.app.inject({
      method: "POST",
      url: api.session.password.path,
      headers: { host: "localhost:3090", origin: "https://localhost:3090" },
      payload: {},
    });
    assert.equal(rejected.statusCode, 403, "a different scheme is a different origin");
    const allowed = await instance.app.inject({
      method: "POST",
      url: api.session.password.path,
      headers: { host: "localhost:3090", origin: "http://localhost:3090" },
      payload: {},
    });
    assert.equal(allowed.statusCode, 400, "same-origin request reaches input validation");
  } finally {
    await instance.close();
  }
});

test("pinned hosts reject other names and ignore untrusted forwarding headers", async () => {
  const instance = await start({ origin: "https://relay.example" }, undefined, { setup: false });
  try {
    assert.equal(
      (await instance.app.inject({ url: api.setup.status.path, headers: { host: "evil.example" } })).statusCode,
      403,
    );
    const response = await instance.app.inject({
      url: api.setup.status.path,
      remoteAddress: "192.0.2.40",
      headers: { host: "relay.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["strict-transport-security"], "max-age=31536000");
    assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(
      (await instance.app.inject({ url: api.health.path, headers: { host: "localhost:3090" } })).statusCode,
      200,
    );
  } finally {
    await instance.close();
  }
});

test("origin configuration rejects credentials and non-web origins", () => {
  for (const value of [
    "https://:secret@relay.example",
    "https://user@relay.example",
    "file:///",
    "https://relay.example/path",
  ])
    assert.throws(() => configFromEnv({ RELAY_ORIGIN: value }), /RELAY_ORIGIN/);
  assert.equal(configFromEnv({ RELAY_ORIGIN: "https://relay.example:443/" }).origin, "https://relay.example");
});

test("the setup key is on unless RELAY_SETUP_KEY turns it off, and a typo stops startup", () => {
  // A fresh or reset server must not be claimable by whoever opens it first.
  assert.equal(configFromEnv({}).setupKey, true);
  assert.equal(configFromEnv({ RELAY_SETUP_KEY: "" }).setupKey, true);
  for (const value of ["false", "0", " FALSE "])
    assert.equal(configFromEnv({ RELAY_SETUP_KEY: value }).setupKey, false);
  for (const value of ["true", "1", "True"]) assert.equal(configFromEnv({ RELAY_SETUP_KEY: value }).setupKey, true);
  for (const value of ["yes", "on", "ture"])
    assert.throws(() => configFromEnv({ RELAY_SETUP_KEY: value }), /RELAY_SETUP_KEY must be true or false/);
  // Off only where the address says the machine is private; a public name keeps the key.
  for (const origin of ["http://localhost:3000", "http://relay.localhost", "http://192.168.1.5", "http://[::1]:8080"])
    assert.equal(configFromEnv({ RELAY_SETUP_KEY: "false", RELAY_ORIGIN: origin }).setupKey, false, origin);
  for (const origin of ["https://relay.example", "https://203.0.113.5", "http://[2001:db8::5]"])
    assert.equal(configFromEnv({ RELAY_SETUP_KEY: "false", RELAY_ORIGIN: origin }).setupKey, true, origin);
});

test("direct transfers are on unless RELAY_DIRECT turns them off, on a valid UDP port", () => {
  assert.deepEqual(configFromEnv({}).local, { port: 3090 });
  assert.deepEqual(configFromEnv({ RELAY_DIRECT: "true", RELAY_DIRECT_PORT: " 4000 " }).local, { port: 4000 });
  assert.equal(configFromEnv({ RELAY_DIRECT: "false" }).local, undefined);
  assert.throws(() => configFromEnv({ RELAY_DIRECT: "off" }), /RELAY_DIRECT must be true or false/);
  for (const value of ["0", "65536", "3090.5", "udp"])
    assert.throws(() => configFromEnv({ RELAY_DIRECT_PORT: value }), /RELAY_DIRECT_PORT/);
});

test("RELAY_DIRECT_ADDRESSES names the private addresses browsers reach the helper at, and nothing else", () => {
  assert.deepEqual(configFromEnv({ RELAY_DIRECT_ADDRESSES: " 192.168.1.23 , fd00::23,192.168.1.23 " }).local, {
    port: 3090,
    addresses: ["192.168.1.23", "fd00::23"],
  });
  assert.deepEqual(configFromEnv({ RELAY_DIRECT_ADDRESSES: " , " }).local, { port: 3090 });
  // A public or loopback address would send browsers' checks beyond the local network, or nowhere.
  for (const value of ["8.8.8.8", "127.0.0.1", "relay.local", "2001:db8::1", "192.168.1"])
    assert.throws(
      () => configFromEnv({ RELAY_DIRECT_ADDRESSES: value }),
      /RELAY_DIRECT_ADDRESSES must list private network addresses/,
    );
  assert.equal(configFromEnv({ RELAY_DIRECT: "false", RELAY_DIRECT_ADDRESSES: "8.8.8.8" }).local, undefined);
});

test("client addresses come only from trusted proxies, given by address, range or host name", async () => {
  assert.deepEqual(configFromEnv({ RELAY_TRUST_PROXY: " cloudflared, 10.0.0.0/8 ,, ::1 " }).trustProxy, [
    "cloudflared",
    "10.0.0.0/8",
    "::1",
  ]);
  assert.deepEqual(configFromEnv({ RELAY_TRUST_PROXY: " " }).trustProxy, ["127.0.0.1", "::1"]);
  for (const entry of [
    "10.0.0.0/33",
    "10.0.0.1/8/8",
    "-proxy",
    "https://proxy",
    "0.0.0.0/0",
    "0.0.0.0/00",
    "0.0.0.0/1",
    "::/0",
    "::/80",
    "::ffff:0.0.0.0/96",
    "2000::/3",
  ])
    assert.throws(() => new ProxyTrust([entry]), /RELAY_TRUST_PROXY/, entry);
  // Private networks, however wide, are fine.
  for (const entry of ["10.0.0.0/8", "172.16.0.0/12", "fd00::/8", "::ffff:10.0.0.0/104"])
    assert.doesNotThrow(() => new ProxyTrust([entry]), entry);
  const pickup = (instance: Instance, address: string) =>
    instance.app.inject({
      method: "POST",
      url: api.pickup.resolve.path,
      remoteAddress: "127.0.0.1",
      headers: { host: "relay.test", "x-forwarded-for": address },
      payload: { code: "short" },
    });
  // Trusted by name, as a tunnel connector's container is: each client keeps its own limit.
  for (const trustProxy of [["localhost"], ["127.0.0.0/8"]]) {
    const behind = await start({ trustProxy }, undefined, { setup: false });
    try {
      for (let i = 1; i <= 6; i++) assert.equal((await pickup(behind, "198.51.100.1")).statusCode, i <= 5 ? 404 : 429);
      assert.equal((await pickup(behind, "198.51.100.2")).statusCode, 404);
    } finally {
      await behind.close();
    }
  }
  // An untrusted peer's header is ignored, as is a name that doesn't resolve: both addresses are the peer's.
  for (const trustProxy of [["192.0.2.1"], ["relay-proxy.invalid"]]) {
    const open = await start({ trustProxy }, undefined, { setup: false });
    try {
      for (let i = 1; i <= 5; i++) await pickup(open, "198.51.100.1");
      assert.equal((await pickup(open, "198.51.100.2")).statusCode, 429);
    } finally {
      await open.close();
    }
  }
  const trust = new ProxyTrust(["192.0.2.0/24"]);
  assert.equal(new ProxyTrust(["streaming_lab_cloudflared"]).trusts("192.0.2.1"), false, "a container name");
  assert.equal(trust.trusts("::ffff:192.0.2.7"), true, "a dual-stack socket's IPv4 peer");
  assert.equal(trust.trusts(undefined), false, "the helper's socket has no peer");

  // A proxy missing from the list is named once in the log, and a trusted one never.
  const warnings: object[] = [];
  const log = { info() {}, warn: (fields: object) => void warnings.push(fields) };
  const proxy = new ProxyTrust(["192.0.2.0/24"]);
  await proxy.start(log);
  proxy.checkForwarded("192.0.2.7", "203.0.113.1");
  proxy.checkForwarded("198.51.100.1", undefined);
  proxy.checkForwarded("::ffff:198.51.100.1", "203.0.113.1");
  proxy.checkForwarded("198.51.100.2", "203.0.113.1");
  assert.deepEqual(warnings, [{ address: "198.51.100.1" }]);
});

test("behind Cloudflare each visitor is counted on their own, never as the tunnel", async () => {
  assert.equal(configFromEnv({ RELAY_CLIENT_IP_HEADER: " CF-Connecting-IP " }).clientIpHeader, "cf-connecting-ip");
  assert.equal(configFromEnv({}).clientIpHeader, undefined);
  assert.throws(() => configFromEnv({ RELAY_CLIENT_IP_HEADER: "cf connecting ip" }), /RELAY_CLIENT_IP_HEADER/);
  // As the gateway sends it: X-Forwarded-For names the tunnel connector, the same for everyone.
  const pickup = (instance: Instance, peer: string, visitor: string) =>
    instance.app.inject({
      method: "POST",
      url: api.pickup.resolve.path,
      remoteAddress: peer,
      headers: { host: "relay.test", "x-forwarded-for": "172.18.0.5", "cf-connecting-ip": visitor },
      payload: { code: "short" },
    });
  const behind = await start(
    { trustProxy: ["127.0.0.1", "172.18.0.0/16"], clientIpHeader: "cf-connecting-ip" },
    undefined,
    { setup: false },
  );
  try {
    for (let i = 1; i <= 6; i++)
      assert.equal((await pickup(behind, "127.0.0.1", "198.51.100.1")).statusCode, i <= 5 ? 404 : 429);
    assert.equal((await pickup(behind, "127.0.0.1", "2001:db8::1")).statusCode, 404, "another visitor still gets in");
    // A value that isn't an address is ignored; the request counts as the proxy, never as an
    // X-Forwarded-For the visitor may have chosen.
    for (let i = 1; i <= 5; i++) await pickup(behind, "127.0.0.1", "not-an-address");
    assert.equal((await pickup(behind, "127.0.0.1", "also-not")).statusCode, 429, "both count as the proxy");
    const chosen = (forwarded: string) =>
      behind.app.inject({
        method: "POST",
        url: api.pickup.resolve.path,
        remoteAddress: "172.18.0.9",
        headers: { host: "relay.test", "x-forwarded-for": forwarded },
        payload: { code: "short" },
      });
    for (let i = 1; i <= 5; i++) assert.equal((await chosen(`198.51.100.${30 + i}`)).statusCode, 404);
    assert.equal((await chosen("198.51.100.99")).statusCode, 429, "without the header, a made-up chain counts as one");
    const page = await behind.app.inject({ url: api.session.get.path, headers: { host: "relay.test" } });
    assert.equal(page.headers["cross-origin-opener-policy"], "same-origin");
    assert.match(String(page.headers["permissions-policy"]), /camera=\(\), microphone=\(\)/);
    // The host is the one the proxy routed by, whatever X-Forwarded-Host says.
    const hosted = (host: string, forwarded: string) =>
      behind.app.inject({
        url: api.session.get.path,
        remoteAddress: "127.0.0.1",
        headers: { host, "x-forwarded-host": forwarded },
      });
    assert.equal((await hosted("evil.test", "relay.test")).statusCode, 403);
    assert.equal((await hosted("relay.test", "evil.test")).statusCode, 401);
    // Anyone reaching Relay without the proxy can't choose their own address with the header.
    for (let i = 1; i <= 5; i++) await pickup(behind, "203.0.113.9", `198.51.100.${10 + i}`);
    assert.equal((await pickup(behind, "203.0.113.9", "198.51.100.99")).statusCode, 429);
  } finally {
    await behind.close();
  }
});

test("visitors aren't shown a running count of their request budget", async () => {
  const instance = await start(undefined, undefined, { setup: false });
  try {
    const response = await instance.app.inject({
      method: "GET",
      url: api.sso.config.path,
      headers: { host: "relay.test" },
      remoteAddress: "198.51.100.1",
    });
    assert.equal(response.statusCode, 200);
    for (const header of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"])
      assert.equal(response.headers[header], undefined, header);
  } finally {
    await instance.close();
  }
});

test("existing data directories are made private at startup", async () => {
  const instance = await start({}, undefined, { setup: false });
  try {
    for (const dir of ["", "blobs", "uploads", "thumbnails"])
      assert.equal((await stat(join(instance.root, dir))).mode & 0o777, 0o700);
    await instance.app.close();
    await chmod(instance.root, 0o755);
    const restarted = await start({}, instance.root, { setup: false });
    try {
      assert.equal((await stat(instance.root)).mode & 0o777, 0o700);
    } finally {
      await restarted.app.close();
    }
  } finally {
    await instance.close();
  }
});
