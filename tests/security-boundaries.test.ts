import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { start, type Instance } from "./support/harness.ts";
import { configFromEnv } from "../server/config.ts";
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

test("on a socket, Relay takes each client's address from the proxy in front of it", async () => {
  assert.equal(configFromEnv({ RELAY_SOCKET: "/run/relay/relay.sock" }).socket, "/run/relay/relay.sock");
  const pickup = (instance: Instance, address: string) =>
    instance.app.inject({
      method: "POST",
      url: api.pickup.resolve.path,
      // A socket's peer has no address; whatever the connection shows, the proxy's header counts.
      remoteAddress: "203.0.113.200",
      headers: { host: "relay.test", "x-forwarded-for": address },
      payload: { code: "short" },
    });
  const behind = await start({ socket: "/unused.sock" }, undefined, { setup: false });
  try {
    for (let i = 1; i <= 5; i++) assert.equal((await pickup(behind, "198.51.100.1")).statusCode, i <= 4 ? 404 : 429);
    assert.equal((await pickup(behind, "198.51.100.2")).statusCode, 404);
    // The container's health check comes without one.
    assert.equal((await behind.app.inject({ url: "/api/health" })).statusCode, 200);
  } finally {
    await behind.close();
  }
  // On a port, an untrusted peer's header is ignored: both addresses are the peer's.
  const open = await start({}, undefined, { setup: false });
  try {
    for (let i = 1; i <= 4; i++) await pickup(open, "198.51.100.1");
    assert.equal((await pickup(open, "198.51.100.2")).statusCode, 429);
  } finally {
    await open.close();
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
