import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { start, Client } from "./support/harness.ts";
import { startProvider } from "./support/sso-provider.ts";
import { api } from "../shared/api.ts";

test("shared sign-in requires explicit linking, creates a real session, and revokes only shared sessions", async () => {
  const provider = await startProvider();
  const instance = await start({ origin: "http://localhost", sso: provider.config });
  const browser = provider.browser(instance);
  try {
    const rejected = await browser.signIn();
    assert.equal(rejected.headers.location, "/?sso=link-required");
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM users"), 1);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM external_identities"), 0);
    const local = new Client(instance);
    await local.signIn("admin", "Test-admin-password-only");
    browser.csrf = local.csrf;
    for (const [k, v] of local.cookies) browser.jar.set(k, v);
    assert.equal((await browser.request("/api/sso/link", "POST", { password: "incorrect-password" })).statusCode, 403);
    const link = await browser.request("/api/sso/link", "POST", { password: "Test-admin-password-only" });
    assert.equal(link.statusCode, 200);
    assert.equal((await browser.finish(link.json<{ url: string }>().url)).headers.location, "/");
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM external_identities"), 1);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM external_sessions"), 1);

    assert.equal((await browser.signIn()).headers.location, "/");
    provider.grants.allowed = false;
    assert.equal((await browser.request("/api/session")).statusCode, 401);
    assert.equal((await local.call(api.session.get)).user.username, "admin");
  } finally {
    await instance.close();
    await provider.close();
  }
});

test("Walriyami's administrator can claim a fresh server by signing in, and setup continues with their choices", async () => {
  const provider = await startProvider();
  const instance = await start({ origin: "http://localhost", sso: provider.config, setupKey: true }, undefined, {
    setup: false,
  });
  const browser = provider.browser(instance);
  try {
    const status = await browser.request("/api/setup");
    assert.deepEqual(status.json(), { state: "account", keyRequired: true, sharedSignIn: true });
    assert.equal((await browser.signIn()).headers.location, "/");
    assert.equal(instance.ctx.db.value("SELECT admin FROM users WHERE username = 'admin'"), 1);
    assert.deepEqual((await browser.request("/api/setup")).json(), {
      state: "choices",
      keyRequired: false,
      sharedSignIn: false,
    });
    assert.ok(!existsSync(join(instance.root, "setup.key")), "the setup key no longer guards anything");
  } finally {
    await instance.close();
    await provider.close();
  }
});

test("a Walriyami member who isn't its administrator can't claim a fresh server", async () => {
  const provider = await startProvider();
  provider.grants.administrator = false;
  const instance = await start({ origin: "http://localhost", sso: provider.config, setupKey: true }, undefined, {
    setup: false,
  });
  const browser = provider.browser(instance);
  try {
    assert.match((await browser.signIn()).headers.location!, /^\/\?sso=/);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM users"), 0);
    assert.equal((await browser.request("/api/session")).statusCode, 401);
    assert.deepEqual((await browser.request("/api/setup")).json(), {
      state: "account",
      keyRequired: true,
      sharedSignIn: true,
    });
  } finally {
    await instance.close();
    await provider.close();
  }
});
