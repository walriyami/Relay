import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { start } from "./support/harness.ts";
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
