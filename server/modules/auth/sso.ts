import type { FastifyInstance } from "fastify";
import { registerSso, type SsoFlow } from "@walriyami/auth";
import type { Context } from "../../context.ts";
import { currentMember, sessionCookie, clearCookie, invalidateRequestAuth } from "../../lib/auth.ts";
import { fail } from "../../lib/errors.ts";
import { hashPassword, randomToken, sha256 } from "../../lib/secrets.ts";
import { insertSession, newDevice, finishSignIn } from "./sessions.ts";
import { insertUser } from "./users.ts";
import { checkPassword } from "./passwords.ts";
import { streamsOf } from "./streams.ts";
import { NO_LIMITS } from "../../../shared/model.ts";
import { beginSetupChoices } from "../setup/index.ts";
import { removeSetupKey } from "../setup/setup-key.ts";

export async function registerSharedSignIn(app: FastifyInstance, ctx: Context) {
  const config = ctx.config.sso;
  const cache = new Map<string, { allowed: boolean; until: number }>();
  const verifiedAdministrators = new Map<string, { administrator: boolean; until: number }>();
  async function control(path: string, body: unknown) {
    if (!config) throw new Error("Shared sign-in is not configured.");
    const r = await fetch(`${config.controlOrigin}/api/apps/${config.projectId}/grants/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.appToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { allowed: false, administrator: false };
    const grant = (await r.json()) as { allowed: boolean; administrator?: boolean };
    return { allowed: grant.allowed === true, administrator: grant.administrator === true };
  }
  await registerSso(app, {
    issuer: config?.issuer,
    clientId: config?.clientId,
    clientSecret: config?.clientSecret,
    origin: ctx.config.origin ?? "http://localhost",
    failureRedirect: "/",
    adapter: {
      saveFlow(state, flow) {
        ctx.db.run("DELETE FROM sso_flows WHERE expires < ?", Date.now());
        ctx.db.run("INSERT INTO sso_flows VALUES(?,?,?)", sha256(state), JSON.stringify(flow), flow.expires);
      },
      takeFlow(state) {
        return ctx.db.tx(() => {
          const row = ctx.db.get<{ value: string }>("SELECT value FROM sso_flows WHERE state_hash = ?", sha256(state));
          ctx.db.run("DELETE FROM sso_flows WHERE state_hash = ?", sha256(state));
          return row ? (JSON.parse(row.value) as SsoFlow) : undefined;
        });
      },
      async authorize(identity, idToken, accessToken) {
        const grant = await control("issue", { idToken, accessToken });
        if (grant.allowed)
          verifiedAdministrators.set(`${identity.issuer}|${identity.subject}`, {
            administrator: grant.administrator,
            until: Date.now() + 300000,
          });
        return grant.allowed;
      },
      findAccount(identity) {
        return ctx.db.value<string>(
          "SELECT user_id FROM external_identities WHERE issuer = ? AND subject = ?",
          identity.issuer,
          identity.subject,
        );
      },
      async createAccount(identity) {
        const username = identity.username.toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username))
          fail(409, "Ask the administrator to create an application account, then link it from Settings.");
        if (ctx.db.get("SELECT 1 FROM users WHERE username = ?", username))
          fail(
            409,
            "An application account already uses this username. Sign in to it, then link Walriyami in Settings.",
          );
        const passwordHash = await hashPassword(randomToken());
        const created = ctx.db.tx(() => {
          const first = !ctx.db.get("SELECT 1 FROM users LIMIT 1");
          const proof = verifiedAdministrators.get(`${identity.issuer}|${identity.subject}`);
          if (first && (!proof?.administrator || proof.until < Date.now()))
            fail(409, "An administrator must complete application setup first.");
          const userId = insertUser(ctx, { username, passwordHash, admin: first }, NO_LIMITS, Date.now());
          // The Walriyami administrator claimed a fresh server: setup continues with their choices.
          if (first) beginSetupChoices(ctx);
          return { userId, first };
        });
        if (created.first) removeSetupKey(ctx.config.root);
        return created.userId;
      },
      linkAccount(userId, identity) {
        ctx.db.tx(() => {
          const other = ctx.db.value<string>(
            "SELECT user_id FROM external_identities WHERE issuer = ? AND subject = ?",
            identity.issuer,
            identity.subject,
          );
          if (other && other !== userId) fail(409, "This identity is already linked to another account.");
          ctx.db.run(
            "INSERT INTO external_identities(issuer,subject,user_id) VALUES(?,?,?) ON CONFLICT(issuer,subject) DO NOTHING",
            identity.issuer,
            identity.subject,
            userId,
          );
        });
      },
      async reauthenticate(req, password) {
        const member = currentMember(ctx, req);
        if (!member) fail(401, "Sign into your application account first.");
        const before = ctx.db.value<string>("SELECT password_hash FROM users WHERE id = ?", member.userId)!;
        if (!(await checkPassword(ctx, member.username, password, before)))
          fail(403, "Application password is incorrect.");
        if (
          currentMember(ctx, req)?.sessionHash !== member.sessionHash ||
          ctx.db.value<string>("SELECT password_hash FROM users WHERE id = ?", member.userId) !== before
        )
          fail(401, "Your account changed. Sign in again.");
        return member.userId;
      },
      logout(req, reply) {
        const member = currentMember(ctx, req);
        if (member) ctx.db.run("DELETE FROM sessions WHERE token_hash = ?", member.sessionHash);
        clearCookie(ctx, reply, sessionCookie(ctx, req));
        streamsOf(ctx).recheck();
      },
      finish(userId, req, reply, identity) {
        const session = insertSession(ctx, userId, newDevice(req, {}), "sso");
        ctx.db.run(
          "INSERT INTO external_sessions VALUES(?,?,?)",
          sha256(session.token),
          identity.issuer,
          identity.subject,
        );
        finishSignIn(ctx, reply, session);
      },
    },
  });
  app.get("/api/sso/account", { config: { auth: "member" } }, (req) => {
    const member = currentMember(ctx, req);
    if (!member) fail(401, "Sign in to continue.");
    return {
      enabled: !!config,
      linked: !!ctx.db.get("SELECT 1 FROM external_identities WHERE user_id = ?", member.userId),
    };
  });
  if (!config) return;
  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.config.auth === "public" || !req.routeOptions.config.auth) return;
    const member = currentMember(ctx, req);
    if (!member) return;
    const external = ctx.db.get<{ issuer: string; subject: string }>(
      "SELECT issuer,subject FROM external_sessions WHERE session_hash = ?",
      member.sessionHash,
    );
    if (!external) return;
    const key = `${external.issuer}|${external.subject}`;
    let grant = cache.get(key);
    if (!grant || grant.until < Date.now()) {
      const allowed = await control("check", external)
        .then((grant) => grant.allowed)
        .catch(() => false);
      grant = { allowed, until: Date.now() + 10000 };
      cache.set(key, grant);
    }
    if (!grant.allowed) {
      ctx.db.run("DELETE FROM sessions WHERE token_hash = ?", member.sessionHash);
      invalidateRequestAuth(req);
      clearCookie(ctx, reply, sessionCookie(ctx, req));
    }
  });
  let refreshing: Promise<void> | undefined;
  let closing = false;
  async function refreshGrants() {
    const identities = ctx.db.all<{ issuer: string; subject: string }>(
      "SELECT DISTINCT e.issuer,e.subject FROM external_sessions e JOIN sessions s ON s.token_hash=e.session_hash WHERE s.expires > ?",
      Date.now(),
    );
    for (const identity of identities) {
      const allowed = await control("check", identity)
        .then((grant) => grant.allowed)
        .catch(() => false);
      if (closing) return;
      cache.set(`${identity.issuer}|${identity.subject}`, { allowed, until: Date.now() + 10000 });
      if (!allowed) {
        ctx.db.run(
          "DELETE FROM sessions WHERE token_hash IN (SELECT session_hash FROM external_sessions WHERE issuer=? AND subject=?)",
          identity.issuer,
          identity.subject,
        );
        streamsOf(ctx).recheck();
      }
    }
  }
  const timer = setInterval(() => {
    refreshing ??= refreshGrants()
      .catch((error: unknown) => {
        app.log.error({ err: error }, "Shared grant refresh failed");
      })
      .finally(() => {
        refreshing = undefined;
      });
  }, 10000);
  timer.unref();
  app.addHook("preClose", async () => {
    closing = true;
    clearInterval(timer);
    await refreshing;
  });
}
