import type { FastifyInstance } from "fastify";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import type { Passkey } from "../../../shared/model.ts";

// Loaded on first use: the library probes experimental Web Crypto features when imported, which
// would otherwise print warnings at every server start.
const webauthn = () => import("@simplewebauthn/server");
import { isUniqueViolation } from "../../db/database.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { randomToken } from "../../lib/secrets.ts";
import { DEFAULT_DEVICE_NAME, finishSignIn, insertSession } from "./sessions.ts";
import { addressKey, perAddress } from "./limits.ts";
import { checkPassword } from "./passwords.ts";

const CHALLENGE_MS = 5 * 60_000;
/** Bounds memory if someone requests options without ever finishing a ceremony. */
const MAX_CHALLENGES_PER_KIND = 10_000;
const MAX_CHALLENGES_PER_IP: Record<ChallengeKind, number> = { register: 50, signin: 150 };

type ChallengeKind = "register" | "signin";
type Challenge = {
  challenge: string;
  kind: ChallengeKind;
  userId: string | null;
  ip: string;
  sessionHash: string | null;
  passwordHash: string | null;
  expires: number;
};

/** Outstanding WebAuthn challenges, each usable once, keyed by an id handed to the client. */
class Challenges {
  private readonly pending: Record<ChallengeKind, Map<string, Challenge>> = {
    register: new Map(),
    signin: new Map(),
  };

  issue(challenge: Challenge): string {
    this.sweep(Date.now());
    const pending = this.pending[challenge.kind];
    const perIp = [...pending.values()].filter((item) => item.ip === challenge.ip).length;
    if (perIp >= MAX_CHALLENGES_PER_IP[challenge.kind]) fail(429, "Too many passkey requests. Try again later.");
    const id = randomToken();
    pending.set(id, challenge);
    if (pending.size > MAX_CHALLENGES_PER_KIND) pending.delete(pending.keys().next().value!);
    return id;
  }

  /** Removes the challenge whether or not it matches, so a response can never be replayed. */
  take(id: string, kind: Challenge["kind"], userId: string | null, sessionHash: string | null = null): Challenge {
    const found = this.pending.register.get(id) ?? this.pending.signin.get(id);
    this.pending.register.delete(id);
    this.pending.signin.delete(id);
    if (
      !found ||
      found.kind !== kind ||
      found.userId !== userId ||
      found.sessionHash !== sessionHash ||
      found.expires <= Date.now()
    )
      fail(400, "This passkey request has expired. Try again.");
    return found;
  }

  sweep(now: number) {
    for (const pending of Object.values(this.pending))
      for (const [id, challenge] of pending) if (challenge.expires <= now) pending.delete(id);
  }
}

const registry = new WeakMap<Context, Challenges>();
export function challengesOf(ctx: Context): Challenges {
  let challenges = registry.get(ctx);
  if (!challenges) registry.set(ctx, (challenges = new Challenges()));
  return challenges;
}

const relyingParty = (ctx: Context) => ({ rpID: new URL(ctx.config.origin).hostname, origin: ctx.config.origin });

function registrationStillAuthorized(ctx: Context, challenge: Challenge, userId: string): boolean {
  return (
    !!challenge.sessionHash &&
    !!challenge.passwordHash &&
    !!ctx.db.get(
      `SELECT 1 FROM users u JOIN sessions s ON s.user_id = u.id
     WHERE u.id = ? AND u.password_hash = ? AND u.disabled = 0
       AND s.token_hash = ? AND s.expires > ?`,
      userId,
      challenge.passwordHash,
      challenge.sessionHash,
      Date.now(),
    )
  );
}

type PasskeyRow = { id: string; name: string; created: number; last_used: number | null };
const toPasskey = (row: PasskeyRow): Passkey => ({
  id: row.id,
  name: row.name,
  created: row.created,
  lastUsed: row.last_used,
});

/** The library throws on malformed input; to the caller that is simply a response that did not verify. */
async function verified<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    return fail(400, "The passkey response could not be verified.");
  }
}

export function registerPasskeys(app: FastifyInstance, ctx: Context) {
  const challenges = challengesOf(ctx);

  route(app, ctx, api.account.passkeys, ({ member }) =>
    ctx.db
      .all<PasskeyRow>(
        "SELECT id, name, created, last_used FROM passkeys WHERE user_id = ? ORDER BY created",
        member.userId,
      )
      .map(toPasskey),
  );

  route(
    app,
    ctx,
    api.account.passkeyOptions,
    async ({ member, body, req }) => {
      const current = ctx.db.value<string>("SELECT password_hash FROM users WHERE id = ?", member.userId)!;
      if (!(await checkPassword(ctx, member.username, body.password, current)))
        fail(403, "Current password is incorrect.");
      if (ctx.db.value<string>("SELECT password_hash FROM users WHERE id = ?", member.userId) !== current)
        fail(403, "Current password is incorrect.");
      const authorization: Challenge = {
        challenge: "",
        kind: "register",
        userId: member.userId,
        ip: addressKey(req.ip),
        sessionHash: member.sessionHash,
        passwordHash: current,
        expires: Date.now() + CHALLENGE_MS,
      };
      const { rpID } = relyingParty(ctx);
      const existing = ctx.db.all<{ id: string; transports: string }>(
        "SELECT id, transports FROM passkeys WHERE user_id = ?",
        member.userId,
      );
      const options = await (
        await webauthn()
      ).generateRegistrationOptions({
        rpName: "Relay",
        rpID,
        userName: member.username,
        userID: new TextEncoder().encode(member.userId),
        attestationType: "none",
        excludeCredentials: existing.map((p) => ({ id: p.id, transports: JSON.parse(p.transports) as string[] })),
        // A resident key lets sign-in start without a username.
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      });
      if (!registrationStillAuthorized(ctx, authorization, member.userId)) fail(401, "Sign in again and retry.");
      const challenge = challenges.issue({
        ...authorization,
        challenge: options.challenge,
      });
      return { challenge, options };
    },
    { rateLimit: perAddress(10, "1 minute") },
  );

  route(app, ctx, api.account.addPasskey, async ({ member, body }) => {
    const authorization = challenges.take(body.challenge, "register", member.userId, member.sessionHash);
    if (!registrationStillAuthorized(ctx, authorization, member.userId)) fail(403, "Current password is incorrect.");
    const { rpID, origin } = relyingParty(ctx);
    const { verifyRegistrationResponse } = await webauthn();
    const result = await verified(() =>
      verifyRegistrationResponse({
        response: body.response as unknown as RegistrationResponseJSON,
        expectedChallenge: authorization.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      }),
    );
    if (!result.verified) fail(400, "The passkey response could not be verified.");
    const { credential } = result.registrationInfo;
    const now = Date.now();
    let name = body.name;
    try {
      ctx.db.tx(() => {
        if (!registrationStillAuthorized(ctx, authorization, member.userId))
          fail(403, "Current password is incorrect.");
        ctx.db.run(
          "INSERT INTO passkeys(id, user_id, public_key, counter, transports, name, created) VALUES(?, ?, ?, ?, ?, ?, ?)",
          credential.id,
          member.userId,
          credential.publicKey,
          credential.counter,
          JSON.stringify(credential.transports ?? []),
          (name = distinctPasskeyName(ctx, member.userId, body.name)),
          now,
        );
        ctx.activity.record(member.userId, { kind: "passkey", change: "added", name }, member.deviceId);
      });
    } catch (error) {
      if (isUniqueViolation(error)) fail(409, "This passkey is already registered.");
      throw error;
    }
    ctx.events.publish(member.userId, "account");
    return toPasskey({ id: credential.id, name, created: now, last_used: null });
  });

  route(app, ctx, api.account.removePasskey, ({ member, params }) => {
    ctx.db.tx(() => {
      const name =
        ctx.db.value<string>("SELECT name FROM passkeys WHERE id = ? AND user_id = ?", params.id, member.userId) ??
        notFound("That passkey");
      ctx.db.run("DELETE FROM passkeys WHERE id = ?", params.id);
      ctx.activity.record(member.userId, { kind: "passkey", change: "removed", name }, member.deviceId);
    });
    ctx.events.publish(member.userId, "account");
    return { ok: true as const };
  });

  route(
    app,
    ctx,
    api.session.passkeyOptions,
    async ({ req }) => {
      const options = await (
        await webauthn()
      ).generateAuthenticationOptions({ rpID: relyingParty(ctx).rpID, userVerification: "required" });
      const challenge = challenges.issue({
        challenge: options.challenge,
        kind: "signin",
        userId: null,
        ip: addressKey(req.ip),
        sessionHash: null,
        passwordHash: null,
        expires: Date.now() + CHALLENGE_MS,
      });
      return { challenge, options };
    },
    { rateLimit: perAddress(30, "1 minute") },
  );

  route(
    app,
    ctx,
    api.session.passkey,
    async ({ body, reply }) => {
      const expectedChallenge = challenges.take(body.challenge, "signin", null).challenge;
      const response = body.response as unknown as AuthenticationResponseJSON;
      type Row = { id: string; user_id: string; public_key: Uint8Array; counter: number; transports: string };
      const stored =
        typeof response.id === "string"
          ? ctx.db.get<Row>(
              `SELECT p.id, p.user_id, p.public_key, p.counter, p.transports
               FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND u.disabled = 0`,
              response.id,
            )
          : undefined;
      if (!stored) fail(401, "This passkey is not registered with Relay.");
      const { rpID, origin } = relyingParty(ctx);
      const { verifyAuthenticationResponse } = await webauthn();
      const result = await verified(() =>
        verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: stored.id,
            publicKey: new Uint8Array(stored.public_key),
            counter: stored.counter,
            transports: JSON.parse(stored.transports) as string[],
          },
          requireUserVerification: true,
        }),
      );
      if (!result.verified) fail(401, "The passkey response could not be verified.");
      const session = ctx.db.tx(() => {
        const updated = ctx.db.run(
          `UPDATE passkeys SET counter = ?, last_used = ?
           WHERE id = ? AND user_id = ? AND public_key = ? AND counter = ?
             AND EXISTS(SELECT 1 FROM users u WHERE u.id = passkeys.user_id AND u.disabled = 0)`,
          result.authenticationInfo.newCounter,
          Date.now(),
          stored.id,
          stored.user_id,
          stored.public_key,
          stored.counter,
        );
        if (!updated.changes) fail(401, "This passkey is no longer registered with Relay.");
        return insertSession(ctx, stored.user_id, body.deviceName ?? DEFAULT_DEVICE_NAME, "passkey");
      });
      return finishSignIn(ctx, reply, session);
    },
    { rateLimit: perAddress(10, "1 minute") },
  );
}

/** Passkeys from the same kind of browser get "Chrome on Mac 2", so each one can be told apart. */
function distinctPasskeyName(ctx: Context, userId: string, name: string) {
  const taken = new Set(
    ctx.db
      .all<{ name: string }>("SELECT name FROM passkeys WHERE user_id = ?", userId)
      .map((p) => p.name.toLowerCase()),
  );
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} ${n}`;
  return candidate;
}
