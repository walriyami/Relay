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

test("the setup key is off unless RELAY_SETUP_KEY turns it on, and a typo stops startup", () => {
  assert.equal(configFromEnv({}).setupKey, false);
  for (const value of ["", "false", "0", " FALSE "])
    assert.equal(configFromEnv({ RELAY_SETUP_KEY: value }).setupKey, false);
  for (const value of ["true", "1", "True"]) assert.equal(configFromEnv({ RELAY_SETUP_KEY: value }).setupKey, true);
  for (const value of ["yes", "on", "ture"])
    assert.throws(() => configFromEnv({ RELAY_SETUP_KEY: value }), /RELAY_SETUP_KEY must be true or false/);
});

test("direct transfers are on unless RELAY_DIRECT turns them off, on a valid UDP port", () => {
  assert.deepEqual(configFromEnv({}).local, { port: 3090 });
  assert.deepEqual(configFromEnv({ RELAY_DIRECT: "true", RELAY_DIRECT_PORT: " 4000 " }).local, { port: 4000 });
  assert.equal(configFromEnv({ RELAY_DIRECT: "false" }).local, undefined);
  assert.throws(() => configFromEnv({ RELAY_DIRECT: "off" }), /RELAY_DIRECT must be true or false/);
  for (const value of ["0", "65536", "3090.5", "udp"])
    assert.throws(() => configFromEnv({ RELAY_DIRECT_PORT: value }), /RELAY_DIRECT_PORT/);
});

test("client addresses come only from trusted proxies, given by address, range or host name", async () => {
  assert.deepEqual(configFromEnv({ RELAY_TRUST_PROXY: " cloudflared, 10.0.0.0/8 ,, ::1 " }).trustProxy, [
    "cloudflared",
    "10.0.0.0/8",
    "::1",
  ]);
  assert.deepEqual(configFromEnv({ RELAY_TRUST_PROXY: " " }).trustProxy, ["127.0.0.1", "::1"]);
  for (const entry of ["10.0.0.0/33", "10.0.0.1/8/8", "-proxy", "https://proxy"])
    assert.throws(() => new ProxyTrust([entry]), /RELAY_TRUST_PROXY/, entry);
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
      for (let i = 1; i <= 5; i++) assert.equal((await pickup(behind, "198.51.100.1")).statusCode, i <= 4 ? 404 : 429);
      assert.equal((await pickup(behind, "198.51.100.2")).statusCode, 404);
    } finally {
      await behind.close();
    }
  }
  // An untrusted peer's header is ignored, as is a name that doesn't resolve: both addresses are the peer's.
  for (const trustProxy of [["192.0.2.1"], ["relay-proxy.invalid"]]) {
    const open = await start({ trustProxy }, undefined, { setup: false });
    try {
      for (let i = 1; i <= 4; i++) await pickup(open, "198.51.100.1");
      assert.equal((await pickup(open, "198.51.100.2")).statusCode, 429);
    } finally {
      await open.close();
    }
  }
  const trust = new ProxyTrust(["::ffff:0:0/96", "192.0.2.0/24"]);
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
