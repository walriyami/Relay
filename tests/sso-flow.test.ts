import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { admin, start, Client } from "./support/harness.ts";
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
    // A browser added with a code from the Walriyami session answers to Walriyami as well.
    browser.csrf = (await browser.request(api.session.get.path)).json<{ csrf: string }>().csrf;
    const code = (await browser.request(api.loginCodes.create.path, "POST")).json<{ code: string }>().code;
    const added = new Client(instance);
    await added.call(api.session.code, { body: { code, deviceName: "Added tablet" } });
    provider.grants.allowed = false;
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    mock.timers.tick(11_000); // past the last answer Relay keeps
    assert.equal((await browser.request("/api/session")).statusCode, 401);
    await assert.rejects(added.call(api.session.get), { status: 401 });
    assert.equal((await local.call(api.session.get)).user.username, "admin");
  } finally {
    mock.timers.reset();
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

test("someone new signing in with Walriyami becomes an ordinary member the administrator can see", async () => {
  const provider = await startProvider({ sub: "friend-1", username: "Friend" });
  const instance = await start({ origin: "http://localhost", sso: provider.config });
  const browser = provider.browser(instance);
  try {
    const boss = await admin(instance);
    assert.equal((await browser.signIn()).headers.location, "/");
    const me = (await browser.request(api.session.get.path)).json<{ user: { username: string; admin: boolean } }>();
    assert.deepEqual([me.user.username, me.user.admin], ["friend", false]);
    const listed = (await boss.call(api.admin.overview)).members.find((m) => m.username === "friend");
    assert.equal(listed?.walriyami, true, "Admin shows how they sign in");
    assert.equal((await boss.call(api.admin.overview)).members.find((m) => m.username === "admin")?.walriyami, false);
    const news = (await boss.call(api.activity.list)).entries.find((e) => e.kind === "joined");
    assert.ok(news?.kind === "joined" && news.walriyami && news.username === "friend", "the administrator is told");
    assert.deepEqual((await browser.request(api.sso.account.path)).json(), { enabled: true, linked: true });
  } finally {
    await instance.close();
    await provider.close();
  }
});

test("Walriyami names that aren't valid usernames are asked to link an account instead", async () => {
  const provider = await startProvider({ sub: "short-1", username: "ab" });
  const instance = await start({ origin: "http://localhost", sso: provider.config });
  try {
    assert.equal((await provider.browser(instance).signIn()).headers.location, "/?sso=link-required");
  } finally {
    await instance.close();
    await provider.close();
  }
});

test("Walriyami Control being down signs nobody out; only its own no does", async () => {
  const provider = await startProvider({ sub: "friend-1", username: "friend" });
  const instance = await start({ origin: "http://localhost", sso: provider.config });
  const browser = provider.browser(instance);
  const session = () => browser.request(api.session.get.path);
  const sessions = () =>
    instance.ctx.db.value<number>(
      "SELECT count(*) FROM external_sessions e JOIN sessions s ON s.token_hash = e.session_hash",
    );
  try {
    assert.equal((await browser.signIn()).headers.location, "/");
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    for (const outage of [502, "hang"] as const) {
      provider.grants.outage = outage;
      mock.timers.tick(11_000);
      const checks = provider.grants.checks;
      assert.equal((await session()).statusCode, 200, `still signed in during a ${outage} outage`);
      assert.ok(provider.grants.checks > checks, "Relay did ask");
    }
    // Long after Control last said yes, requests wait for it, but the session survives.
    mock.timers.tick(2 * 3_600_000);
    const waiting = await session();
    assert.equal(waiting.statusCode, 503);
    assert.match(waiting.json<{ error: string }>().error, /can't reach Walriyami/);
    assert.equal(sessions(), 1);
    // A new sign-in needs Control's answer.
    assert.equal((await provider.browser(instance).signIn()).headers.location, "/?sso=unavailable");

    provider.grants.outage = undefined;
    mock.timers.tick(11_000);
    assert.equal((await session()).statusCode, 200, "back as soon as Control answers");

    provider.grants.allowed = false;
    mock.timers.tick(11_000);
    assert.equal((await session()).statusCode, 401);
    assert.equal(sessions(), 0, "Control's no ends the session");
  } finally {
    mock.timers.reset();
    await instance.close();
    await provider.close();
  }
});
