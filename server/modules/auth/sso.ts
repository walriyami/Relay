// Walriyami sign-in: Walriyami's login proves who someone is, and Walriyami Control says whether
// they may use Relay. Relay asks Control again every few seconds while a Walriyami session is in
// use, so access taken away there ends here quickly.
//
// Control being unreachable is not an answer. Sessions it confirmed recently keep working through
// an outage, and after a long one requests wait for Control rather than signing anyone out.
// Only Control's own "not allowed" ends a session. New Walriyami sign-ins need Control to answer.
import type { FastifyInstance } from "fastify";
import { registerSso, type SsoFlow } from "@walriyami/auth";
import type { Context } from "../../context.ts";
import { currentMember, sessionCookie, clearCookie, invalidateRequestAuth } from "../../lib/auth.ts";
import { fail } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { hashPassword, randomToken, sha256 } from "../../lib/secrets.ts";
import { insertSession, newDevice, finishSignIn } from "./sessions.ts";
import { insertUser } from "./users.ts";
import { checkPassword } from "./passwords.ts";
import { streamsOf } from "./streams.ts";
import { api } from "../../../shared/api.ts";
import { NO_LIMITS, USERNAME } from "../../../shared/model.ts";
import { beginSetupChoices } from "../setup/index.ts";
import { removeSetupKey } from "../setup/setup-key.ts";

/** How long Control's answer about someone holds before Relay asks again. */
const CHECK_EVERY_MS = 10_000;
/** How long a session Control last allowed keeps working while Control can't be reached. */
export const OUTAGE_GRACE_MS = 60 * 60_000;
/** How long Relay waits for Control to answer. */
const CONTROL_TIMEOUT_MS = 5_000;
/** How long Control's word that someone is Walriyami's administrator lets them claim a fresh server. */
const ADMINISTRATOR_PROOF_MS = 5 * 60_000;

type Identity = { issuer: string; subject: string };
/** Control's answer: allowed, not allowed, or none (it couldn't be reached or answered oddly). */
type Answer = "allowed" | "denied" | "unknown";
/**
 * What Relay holds about someone. `confirmed` is when Control last allowed them (or, after a
 * restart during an outage, when Relay first had to go without its answer).
 */
type Grant = { answer: Answer; checked: number; confirmed: number };

export async function registerSharedSignIn(app: FastifyInstance, ctx: Context) {
  const config = ctx.config.sso;
  const grants = new Map<string, Grant>();
  const checking = new Map<string, Promise<Grant>>();
  const verifiedAdministrators = new Map<string, { administrator: boolean; until: number }>();
  /** When Control stopped answering, while it hasn't; the log says so once per outage. */
  let outageSince: number | undefined;

  /** Control's answer, or an error when it gives none: an outage is never a "no". */
  async function control(path: string, body: unknown) {
    if (!config) throw new Error("Shared sign-in is not configured.");
    const r = await fetch(`${config.controlOrigin}/api/apps/${config.projectId}/grants/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.appToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`Walriyami Control answered ${r.status}.`);
    const grant = (await r.json()) as { allowed?: unknown; administrator?: unknown };
    if (typeof grant.allowed !== "boolean") throw new Error("Walriyami Control's answer had no decision.");
    return { allowed: grant.allowed, administrator: grant.administrator === true };
  }

  /** Asks Control about someone and records what that means for their sessions. */
  async function check(identity: Identity): Promise<Grant> {
    const key = `${identity.issuer}|${identity.subject}`;
    const now = Date.now();
    const prior = grants.get(key);
    let answer: Answer;
    try {
      answer = (await control("check", identity)).allowed ? "allowed" : "denied";
      if (outageSince !== undefined) {
        app.log.info("Walriyami Control is answering again.");
        outageSince = undefined;
      }
    } catch (error) {
      answer = "unknown";
      if (outageSince === undefined) {
        outageSince = now;
        app.log.warn(
          { err: error },
          "Walriyami Control can't be reached. People already signed in with Walriyami keep working for up to an hour.",
        );
      }
    }
    const grant: Grant = {
      answer,
      checked: Date.now(),
      confirmed: answer === "allowed" ? Date.now() : (prior?.confirmed ?? now),
    };
    grants.set(key, grant);
    if (answer === "denied")
      ctx.db.run(
        "DELETE FROM sessions WHERE token_hash IN (SELECT session_hash FROM external_sessions WHERE issuer=? AND subject=?)",
        identity.issuer,
        identity.subject,
      );
    return grant;
  }

  /** One check at a time per person, however many of their requests arrive together. */
  function checkOnce(identity: Identity) {
    const key = `${identity.issuer}|${identity.subject}`;
    let pending = checking.get(key);
    if (!pending) {
      pending = check(identity).finally(() => checking.delete(key));
      checking.set(key, pending);
    }
    return pending;
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
      // A new sign-in needs Control's answer: when it can't be reached, the sign-in page says
      // Walriyami is unavailable rather than letting anyone in.
      async authorize(identity, idToken, accessToken) {
        const grant = await control("issue", { idToken, accessToken });
        if (grant.allowed)
          verifiedAdministrators.set(`${identity.issuer}|${identity.subject}`, {
            administrator: grant.administrator,
            until: Date.now() + ADMINISTRATOR_PROOF_MS,
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
        if (!USERNAME.test(username))
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
          // The same as joining with an invitation that sets no limits; administrators change them in Admin.
          const userId = insertUser(ctx, { username, passwordHash, admin: first }, NO_LIMITS, Date.now());
          // The Walriyami administrator claimed a fresh server: setup continues with their choices.
          if (first) beginSetupChoices(ctx);
          const administrators = first
            ? []
            : ctx.db.all<{ id: string }>("SELECT id FROM users WHERE admin = 1 AND disabled = 0 AND id != ?", userId);
          for (const { id } of administrators)
            ctx.activity.record(id, { kind: "joined", userId, username, note: null, walriyami: true });
          return { userId, first, administrators };
        });
        if (created.first) removeSetupKey(ctx.config.root);
        // Administrators see the new member in Admin straight away.
        for (const { id } of created.administrators) ctx.events.publish(id, "account");
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
        if (
          !(await checkPassword(
            ctx,
            req,
            { username: member.username, userId: member.userId, signedIn: true },
            password,
            before,
          ))
        )
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
  route(app, ctx, api.sso.account, ({ member }) => ({
    enabled: !!config,
    linked: !!ctx.db.get("SELECT 1 FROM external_identities WHERE user_id = ?", member.userId),
  }));
  if (!config) {
    route(app, ctx, api.sso.link, () => fail(404, "Walriyami sign-in isn't set up on this server."));
    return;
  }
  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.config.auth === "public" || !req.routeOptions.config.auth) return;
    const member = currentMember(ctx, req);
    if (!member) return;
    const external = ctx.db.get<Identity>(
      "SELECT issuer,subject FROM external_sessions WHERE session_hash = ?",
      member.sessionHash,
    );
    if (!external) return;
    let grant = grants.get(`${external.issuer}|${external.subject}`);
    if (!grant || grant.checked + CHECK_EVERY_MS < Date.now()) grant = await checkOnce(external);
    if (grant.answer === "denied") {
      ctx.db.run("DELETE FROM sessions WHERE token_hash = ?", member.sessionHash);
      invalidateRequestAuth(req);
      clearCookie(ctx, reply, sessionCookie(ctx, req));
      streamsOf(ctx).recheck();
    } else if (grant.answer === "unknown" && grant.confirmed + OUTAGE_GRACE_MS < Date.now())
      fail(503, "Relay can't reach Walriyami to confirm your access. Try again in a few minutes.");
  });
  let refreshing: Promise<void> | undefined;
  let closing = false;
  async function refreshGrants() {
    const identities = ctx.db.all<Identity>(
      "SELECT DISTINCT e.issuer,e.subject FROM external_sessions e JOIN sessions s ON s.token_hash=e.session_hash WHERE s.expires > ?",
      Date.now(),
    );
    for (const identity of identities) {
      const grant = await checkOnce(identity);
      if (closing) return;
      if (grant.answer === "denied") streamsOf(ctx).recheck();
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
  }, CHECK_EVERY_MS);
  timer.unref();
  app.addHook("preClose", async () => {
    closing = true;
    clearInterval(timer);
    await refreshing;
  });
}
