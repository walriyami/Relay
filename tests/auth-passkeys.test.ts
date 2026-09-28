// A full WebAuthn ceremony against a minimal software authenticator: an ES256 key, "none"
// attestation, and hand-built authenticatorData, clientDataJSON and CBOR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { encodeCBOR, type CBORType } from "@levischuck/tiny-cbor";
import { api } from "../shared/api.ts";
import { sweepAuth } from "../server/modules/auth/index.ts";
import { challengesOf } from "../server/modules/auth/passkeys.ts";
import { addressKey } from "../server/modules/auth/limits.ts";
import { ApiError, Client, member, start } from "./support/harness.ts";

const ORIGIN = "http://relay.test";
const b64url = (data: Uint8Array | string) => Buffer.from(data).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

class SoftwareAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private counter = 0;
  private userHandle = "";
  constructor() {
    ({ privateKey: this.privateKey, publicKey: this.publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" }));
  }

  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
  }

  /** navigator.credentials.create() */
  create(options: { challenge: string; rp: { id: string }; user: { id: string } }, userVerified = true) {
    this.userHandle = options.user.id;
    const jwk = this.publicKey.export({ format: "jwk" });
    const coseKey = encodeCBOR(
      new Map<number, CBORType>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(options.rp.id),
      Buffer.from([userVerified ? 0x45 : 0x41]), // user present, optional UV, attested credential data
      u32(this.counter),
      Buffer.alloc(16), // aaguid
      idLength,
      this.credentialId,
      Buffer.from(coseKey),
    ]);
    const attestationObject = encodeCBOR(
      new Map<string, CBORType>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get() */
  get(options: { challenge: string; rpId: string }, userVerified = true) {
    this.counter++;
    const authData = Buffer.concat([
      sha256(options.rpId),
      Buffer.from([userVerified ? 0x05 : 0x01]),
      u32(this.counter),
    ]);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}

type RegistrationOptions = Parameters<SoftwareAuthenticator["create"]>[0] & {
  authenticatorSelection: { residentKey: string; userVerification: string };
};
type SignInOptions = Parameters<SoftwareAuthenticator["get"]>[0] & {
  allowCredentials?: unknown[];
  userVerification: string;
};

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

test("a passkey registers and then signs in without a username", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "mina");
    const authenticator = new SoftwareAuthenticator();

    const registration = await owner.call(api.account.passkeyOptions, {
      body: { password: "Member-password-only" },
    });
    const options = registration.options as RegistrationOptions;
    assert.equal(options.rp.id, "relay.test");
    assert.equal(options.authenticatorSelection.residentKey, "required");
    assert.equal(options.authenticatorSelection.userVerification, "required");
    const added = await owner.call(api.account.addPasskey, {
      body: { challenge: registration.challenge, name: "Laptop key", response: authenticator.create(options) },
    });
    assert.equal(added.name, "Laptop key");
    assert.equal(added.lastUsed, null);

    const noUvRegistration = await owner.call(api.account.passkeyOptions, {
      body: { password: "Member-password-only" },
    });
    const noUvAdd = owner.call(api.account.addPasskey, {
      body: {
        challenge: noUvRegistration.challenge,
        name: "No user verification",
        response: authenticator.create(noUvRegistration.options as RegistrationOptions, false),
      },
    });
    assert.equal(await status(noUvAdd), 400, "registration rejects an authenticator response without UV");
    assert.deepEqual(
      (await owner.call(api.account.passkeys)).map((p) => p.id),
      [added.id],
    );

    const browser = new Client(instance);
    const signIn = await browser.call(api.session.passkeyOptions);
    const request = signIn.options as SignInOptions;
    assert.equal(request.allowCredentials?.length ?? 0, 0, "usernameless: no credential list");
    assert.equal(request.userVerification, "required");

    const noUvSignIn = await browser.call(api.session.passkeyOptions);
    const noUvAssertion = browser.call(api.session.passkey, {
      body: {
        challenge: noUvSignIn.challenge,
        response: authenticator.get(noUvSignIn.options as SignInOptions, false),
      },
    });
    assert.equal(await status(noUvAssertion), 400, "sign-in rejects an authenticator response without UV");
    const assertion = authenticator.get(request);
    const me = await browser.call(api.session.passkey, {
      body: { challenge: signIn.challenge, response: assertion, deviceName: "Passkey browser" },
    });
    assert.equal(me.user.username, "mina");
    assert.equal(me.device.name, "Passkey browser");
    await browser.call(api.session.get);
    const [stored] = await owner.call(api.account.passkeys);
    assert.ok(stored.lastUsed);
    // The rejected no-UV assertion still advanced the authenticator's local counter.
    assert.equal(instance.ctx.db.value("SELECT counter FROM passkeys"), 2);

    // The same challenge cannot be used twice, and a made-up one is refused.
    const replay = new Client(instance).call(api.session.passkey, {
      body: { challenge: signIn.challenge, response: assertion },
    });
    assert.equal(await status(replay), 400);
    const unknown = new Client(instance).call(api.session.passkey, {
      body: { challenge: "made-up", response: assertion },
    });
    assert.equal(await status(unknown), 400);

    // A response signed over a different challenge does not verify.
    const fresh = await new Client(instance).call(api.session.passkeyOptions);
    const forged = authenticator.get({ rpId: "relay.test", challenge: b64url(randomBytes(32)) });
    const wrongChallenge = new Client(instance).call(api.session.passkey, {
      body: { challenge: fresh.challenge, response: forged },
    });
    assert.equal(await status(wrongChallenge), 400);

    // An unregistered credential is refused.
    const stranger = new SoftwareAuthenticator();
    stranger.create(options);
    const again = await new Client(instance).call(api.session.passkeyOptions);
    const unregistered = new Client(instance).call(api.session.passkey, {
      body: { challenge: again.challenge, response: stranger.get(again.options as SignInOptions) },
    });
    assert.equal(await status(unregistered), 401);

    // Registering the same credential twice conflicts; a registration challenge cannot sign in.
    const repeat = await owner.call(api.account.passkeyOptions, { body: { password: "Member-password-only" } });
    const duplicate = owner.call(api.account.addPasskey, {
      body: {
        challenge: repeat.challenge,
        name: "Again",
        response: authenticator.create(repeat.options as RegistrationOptions),
      },
    });
    assert.equal(await status(duplicate), 409);
    const crossed = await owner.call(api.account.passkeyOptions, { body: { password: "Member-password-only" } });
    const misuse = new Client(instance).call(api.session.passkey, {
      body: {
        challenge: crossed.challenge,
        response: authenticator.get({
          rpId: "relay.test",
          challenge: (crossed.options as RegistrationOptions).challenge,
        }),
      },
    });
    assert.equal(await status(misuse), 400);

    // Removed passkeys no longer sign in.
    await owner.call(api.account.removePasskey, { params: { id: added.id } });
    assert.deepEqual(await owner.call(api.account.passkeys), []);
    const last = await new Client(instance).call(api.session.passkeyOptions);
    const removed = new Client(instance).call(api.session.passkey, {
      body: { challenge: last.challenge, response: authenticator.get(last.options as SignInOptions) },
    });
    assert.equal(await status(removed), 401);
  } finally {
    await instance.close();
  }
});

test("passkey challenges expire", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "nora");
    const registration = await owner.call(api.account.passkeyOptions, { body: { password: "Member-password-only" } });
    const response = new SoftwareAuthenticator().create(registration.options as RegistrationOptions);
    await sweepAuth(instance.ctx, Date.now() + 5 * 60_000 + 1);
    const late = owner.call(api.account.addPasskey, {
      body: { challenge: registration.challenge, name: "Late", response },
    });
    assert.equal(await status(late), 400);
  } finally {
    await instance.close();
  }
});

test("passkey registration requires the current password and binds the ceremony to it", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "pavel");
    const wrong = await owner.raw({
      method: "POST",
      url: api.account.passkeyOptions.path,
      payload: { password: "Not-the-current-password" },
    });
    assert.equal(wrong.statusCode, 403);
    assert.equal(wrong.json<{ error: string }>().error, "Current password is incorrect.");

    const options = await owner.call(api.account.passkeyOptions, { body: { password: "Member-password-only" } });
    const response = new SoftwareAuthenticator().create(options.options as RegistrationOptions);
    await owner.call(api.account.password, {
      body: { current: "Member-password-only", password: "Changed-member-password" },
    });
    assert.equal(
      await status(
        owner.call(api.account.addPasskey, {
          body: { challenge: options.challenge, name: "Old authorization", response },
        }),
      ),
      403,
      "a ceremony issued before the password change cannot add a passkey",
    );
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM passkeys"), 0);

    const createOptions = () =>
      owner.call(api.account.passkeyOptions, { body: { password: "Changed-member-password" } });
    for (let i = 0; i < 8; i++) await createOptions();
    assert.equal(await status(createOptions()), 429, "registration options use the sign-in rate limit");
  } finally {
    await instance.close();
  }
});

test("registration and sign-in challenges have separate per-address caps", async () => {
  const instance = await start();
  try {
    const challenges = challengesOf(instance.ctx);
    const ip = addressKey("2001:db8:abcd:12::1");
    const issue = (kind: "register" | "signin") =>
      challenges.issue({
        challenge: crypto.randomUUID(),
        kind,
        userId: kind === "register" ? "member-id" : null,
        ip,
        sessionHash: kind === "register" ? "session-hash" : null,
        passwordHash: kind === "register" ? "password-hash" : null,
        expires: Date.now() + 60_000,
      });
    for (let i = 0; i < 50; i++) issue("register");
    assert.throws(
      () => issue("register"),
      (error: unknown) => (error as { status?: number }).status === 429,
    );
    for (let i = 0; i < 150; i++) issue("signin");
    assert.throws(
      () => issue("signin"),
      (error: unknown) => (error as { status?: number }).status === 429,
    );
  } finally {
    await instance.close();
  }
});

test("concurrent passkey assertions cannot create two sessions from one stored counter", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "quinn");
    const sessionsBefore = instance.ctx.db.value<number>("SELECT COUNT(*) FROM sessions")!;
    const authenticator = new SoftwareAuthenticator();
    const registration = await owner.call(api.account.passkeyOptions, { body: { password: "Member-password-only" } });
    await owner.call(api.account.addPasskey, {
      body: {
        challenge: registration.challenge,
        name: "Laptop key",
        response: authenticator.create(registration.options as RegistrationOptions),
      },
    });

    const first = new Client(instance);
    const second = new Client(instance);
    const [firstRequest, secondRequest] = await Promise.all([
      first.call(api.session.passkeyOptions),
      second.call(api.session.passkeyOptions),
    ]);
    const firstSignin = first.call(api.session.passkey, {
      body: {
        challenge: firstRequest.challenge,
        response: authenticator.get(firstRequest.options as SignInOptions),
      },
    });
    const secondSignin = second.call(api.session.passkey, {
      body: {
        challenge: secondRequest.challenge,
        response: authenticator.get(secondRequest.options as SignInOptions),
      },
    });
    const results = await Promise.allSettled([firstSignin, secondSignin]);
    const statuses = results.map((result) =>
      result.status === "fulfilled" ? 200 : (result.reason as ApiError).status,
    );
    assert.equal(statuses.filter((code) => code === 200).length, 1);
    assert.equal(statuses.filter((code) => code === 401).length, 1);
    assert.equal(
      instance.ctx.db.value("SELECT COUNT(*) FROM sessions"),
      sessionsBefore + 1,
      "only one new session is created",
    );
  } finally {
    await instance.close();
  }
});

test("passkeys with the same default name are numbered", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "mina");
    const names = [];
    for (let i = 0; i < 3; i++) {
      const registration = await owner.call(api.account.passkeyOptions, {
        body: { password: "Member-password-only" },
      });
      const added = await owner.call(api.account.addPasskey, {
        body: {
          challenge: registration.challenge,
          name: i === 2 ? "chrome ON mac" : "Chrome on Mac",
          response: new SoftwareAuthenticator().create(registration.options as RegistrationOptions),
        },
      });
      names.push(added.name);
    }
    assert.deepEqual(names, ["Chrome on Mac", "Chrome on Mac 2", "chrome ON mac 3"]);
    assert.deepEqual((await owner.call(api.account.passkeys)).map((p) => p.name).sort(), [...names].sort());
  } finally {
    await instance.close();
  }
});
