// Independent account-lifecycle verification. Every account, key, file and socket is disposable.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { after, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import filesystem from "node:fs/promises";
import { request } from "node:http";
import { createSocket } from "node:dgram";
import { join } from "node:path";
import { api } from "../shared/api.ts";
import { LOCAL_TOKEN_HEADER, SOCKETS } from "../shared/local.ts";

// Hold an actual scrypt callback after the native computation. This creates a deterministic
// authorization boundary without bypassing password verification or touching application code.
const nativeScrypt = crypto.scrypt;
let held: null | { skip: number; started: () => void; release: Promise<void> } = null;
crypto.scrypt = (...args: unknown[]) => {
  const callback = args.pop() as (...result: unknown[]) => void;
  let current: typeof held = null;
  if (held && held.skip-- === 0) {
    current = held;
    held = null;
    current.started();
  }
  return (nativeScrypt as (...values: unknown[]) => void)(...args, (...result: unknown[]) => {
    if (current) void current.release.then(() => callback(...result));
    else callback(...result);
  });
};
syncBuiltinESMExports();
const { Client, admin, member, patchUpload, start } = await import("./support/harness.ts");
const { sha256 } = await import("../server/lib/secrets.ts");
type Client = InstanceType<typeof Client>;
type Instance = Awaited<ReturnType<typeof start>>;

type Evidence = { case: string; expected: number; observed: number; unchanged?: boolean; control?: number };
const evidence: Evidence[] = [];
const record = (value: Evidence) => evidence.push(value);
after(async () => {
  crypto.scrypt = nativeScrypt;
  syncBuiltinESMExports();
  await mkdir("work/security-audit", { recursive: true });
  const path = process.env.RELAY_ACCOUNT_EVIDENCE_PATH ?? "work/security-audit/account-verification-runtime.json";
  await writeFile(path, JSON.stringify(evidence, null, 2) + "\n");
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};
function holdDerivation(skip = 0) {
  assert.equal(held, null);
  const began = deferred();
  const release = deferred();
  held = { skip, started: began.resolve, release: release.promise };
  return { began: began.promise, release: release.resolve };
}
const sessionHash = (client: Client) => {
  const token = [...client.cookies].find(([key]) => key === "relay" || key === "__Host-relay")?.[1];
  assert.ok(token);
  return sha256(token);
};
const passwordHash = (instance: Instance, userId: string) =>
  instance.ctx.db.value<string>("SELECT password_hash FROM users WHERE id = ?", userId);
const expire = (instance: Instance, hash: string) =>
  instance.ctx.db.run("UPDATE sessions SET expires = ? WHERE token_hash = ?", Date.now() - 1, hash);
const manifest = (client: Client) => ({
  id: crypto.randomUUID(),
  tab: client.tab,
  name: null,
  folders: [],
  files: [{ path: "empty.txt", size: 0, mime: "text/plain" }],
});

test("account lifecycle: expiry immediately blocks an old session and its sign-in capabilities", async () => {
  const instance = await start();
  try {
    const user = await member(instance, "expiry-audit");
    const other = new Client(instance);
    await other.signIn("expiry-audit", "Member-password-only", "Other browser");
    const code = await user.call(api.loginCodes.create);
    const created = await user.call(api.transfers.create, { body: manifest(user) });
    expire(instance, sessionHash(user));
    const old = await user.raw({ method: "GET", url: api.session.get.path });
    const mutation = await user.raw({ method: "PATCH", url: api.account.update.path, payload: { name: "stale" } });
    const staleCode = await new Client(instance).raw({
      method: "POST",
      url: api.session.deviceLink.path,
      payload: { token: code.token, deviceName: "Expired capability" },
    });
    assert.equal(old.statusCode, 401);
    assert.equal(mutation.statusCode, 401);
    assert.equal(staleCode.statusCode, 410);
    assert.equal((await other.raw({ method: "GET", url: api.session.get.path })).statusCode, 200);
    await other.call(api.transfers.complete, { params: { id: created.id }, body: { destination: { kind: "save" } } });
    record({
      case: "expired session denied; same-user second session can finish user-owned transfer",
      expected: 401,
      observed: old.statusCode,
      control: 200,
    });
  } finally {
    await instance.close();
  }
});

test("account lifecycle: pending password changes require the initiating session to remain valid", async (t) => {
  for (const revocation of ["signout", "expiry", "disable", "password-reset"] as const) {
    await t.test(revocation, async () => {
      const instance = await start();
      let release: (() => void) | undefined;
      try {
        const administrator = await admin(instance);
        const user = await member(instance, `password-${revocation}`, administrator);
        const userId = (await user.call(api.session.get)).user.id;
        const before = passwordHash(instance, userId);
        const hash = sessionHash(user);
        const gate = holdDerivation(1); // verify the current password, then hold the new password hash.
        release = gate.release;
        const pending = user.raw({
          method: "POST",
          url: api.account.password.path,
          payload: { current: "Member-password-only", password: "Pending-change-password" },
        });
        await gate.began;
        if (revocation === "signout") await user.call(api.session.signOut);
        else if (revocation === "expiry") expire(instance, hash);
        else if (revocation === "disable")
          await administrator.call(api.admin.updateMember, { params: { id: userId }, body: { disabled: true } });
        else
          await administrator.call(api.admin.resetPassword, {
            params: { id: userId },
            body: { password: "Replacement-admin-password" },
          });
        const authoritative = passwordHash(instance, userId);
        gate.release();
        const response = await pending;
        const expected = revocation === "password-reset" ? 409 : 401;
        const unchanged = passwordHash(instance, userId) === authoritative;
        record({
          case: `pending account.password after ${revocation}`,
          expected,
          observed: response.statusCode,
          unchanged,
        });
        assert.equal(response.statusCode, expected, response.body);
        assert.equal(unchanged, true, "revoked request must not change the authoritative password");
        if (revocation !== "password-reset") assert.equal(passwordHash(instance, userId), before);
      } finally {
        release?.();
        await instance.close();
      }
    });
  }
});

test("account lifecycle: pending administrator resets require the initiating session to remain valid", async (t) => {
  for (const revocation of ["signout", "expiry", "role-loss"] as const) {
    await t.test(revocation, async () => {
      const instance = await start();
      let release: (() => void) | undefined;
      try {
        const administrator = await admin(instance);
        const user = await member(instance, `reset-${revocation}`, administrator);
        const userId = (await user.call(api.session.get)).user.id;
        const before = passwordHash(instance, userId);
        const hash = sessionHash(administrator);
        const gate = holdDerivation();
        release = gate.release;
        const pending = administrator.raw({
          method: "POST",
          url: api.admin.resetPassword.path.replace(":id", userId),
          payload: { password: "Pending-admin-reset-password" },
        });
        await gate.began;
        if (revocation === "signout") await administrator.call(api.session.signOut);
        else if (revocation === "expiry") expire(instance, hash);
        else
          instance.ctx.db.run(
            "UPDATE users SET admin = 0 WHERE id = (SELECT user_id FROM sessions WHERE token_hash = ?)",
            hash,
          );
        gate.release();
        const response = await pending;
        const unchanged = passwordHash(instance, userId) === before;
        const expected = revocation === "role-loss" ? 403 : 401;
        record({
          case: `pending admin.resetPassword after ${revocation}`,
          expected,
          observed: response.statusCode,
          unchanged,
        });
        assert.equal(response.statusCode, expected, response.body);
        assert.equal(unchanged, true, "revoked administrator must not reset a member");
        assert.equal(
          (await user.raw({ method: "GET", url: api.session.get.path })).statusCode,
          200,
          "refused reset must preserve the target's session",
        );
      } finally {
        release?.();
        await instance.close();
      }
    });
  }
});

test("account lifecycle: pending password sign-ins cannot survive account disable or password reset", async (t) => {
  for (const change of ["disable", "password-reset"] as const) {
    await t.test(change, async () => {
      const instance = await start();
      let release: (() => void) | undefined;
      try {
        const administrator = await admin(instance);
        const username = `login-${change}`;
        const user = await member(instance, username, administrator);
        const userId = (await user.call(api.session.get)).user.id;
        const candidate = new Client(instance);
        const gate = holdDerivation();
        release = gate.release;
        const pending = candidate.raw({
          method: "POST",
          url: api.session.password.path,
          payload: { username, password: "Member-password-only", deviceName: "Pending login" },
        });
        await gate.began;
        if (change === "disable")
          await administrator.call(api.admin.updateMember, { params: { id: userId }, body: { disabled: true } });
        else
          await administrator.call(api.admin.resetPassword, {
            params: { id: userId },
            body: { password: "New-authoritative-password" },
          });
        gate.release();
        const response = await pending;
        const expected = change === "disable" ? 403 : 401;
        const unchanged =
          instance.ctx.db.value<number>("SELECT COUNT(*) FROM sessions WHERE user_id = ?", userId) === 0;
        record({
          case: `pending session.password after ${change}`,
          expected,
          observed: response.statusCode,
          unchanged,
        });
        assert.equal(response.statusCode, expected, response.body);
        assert.equal(unchanged, true, "stale authentication must not create a new session");
      } finally {
        release?.();
        await instance.close();
      }
    });
  }
});

test("account lifecycle: a pending transfer cannot borrow a same-user second session after signout", async () => {
  const instance = await start();
  let release: (() => void) | undefined;
  try {
    const user = await member(instance, "transfer-session");
    const other = new Client(instance);
    await other.signIn("transfer-session", "Member-password-only", "Second session");
    const transfer = await user.call(api.transfers.create, { body: manifest(user) });
    const gate = holdDerivation();
    release = gate.release;
    const pending = user.raw({
      method: "POST",
      url: api.transfers.complete.path.replace(":id", transfer.id),
      payload: { destination: { kind: "link", days: 1, password: "Protected-link-password" } },
    });
    await gate.began;
    await user.call(api.session.signOut);
    gate.release();
    const response = await pending;
    const unchanged = instance.ctx.db.value("SELECT COUNT(*) FROM links WHERE item = ?", transfer.itemId) === 0;
    record({
      case: "pending transfer after initiating-session signout while same-user session remains valid",
      expected: 401,
      observed: response.statusCode,
      unchanged,
    });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(unchanged, true, "no share may be published by the revoked request");
    await other.call(api.transfers.complete, { params: { id: transfer.id }, body: { destination: { kind: "save" } } });
    assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", transfer.id), "complete");
  } finally {
    release?.();
    await instance.close();
  }
});

test("account lifecycle: revocation during file close or directory sync cannot commit upload progress", async (t) => {
  for (const boundary of ["file-close", "file-close-prefix", "directory-sync"] as const) {
    await t.test(boundary, async () => {
      const instance = await start();
      const actualOpen = filesystem.open;
      const reached = deferred();
      const release = deferred();
      let pending: ReturnType<typeof patchUpload> | undefined;
      try {
        const user = await member(instance, `offset-${boundary}`);
        const userId = (await user.call(api.session.get)).user.id;
        const other = new Client(instance);
        await other.signIn(`offset-${boundary}`, "Member-password-only", "Resume browser");
        const created = await user.call(api.transfers.create, {
          body: {
            ...manifest(user),
            files: [{ path: "resumable.txt", size: 4, mime: "text/plain" }],
          },
        });
        const uploadId = created.uploads[0].id;
        const uploadDir = join(instance.root, "uploads");
        const committed = boundary === "file-close-prefix" ? 1 : 0;
        if (committed) assert.equal((await patchUpload(user, uploadId, 0, Buffer.from("Q"))).statusCode, 204);
        let armed = true;
        filesystem.open = async (...args: Parameters<typeof actualOpen>) => {
          const file = await actualOpen(...args);
          const path = String(args[0]);
          if (armed && boundary.startsWith("file-close") && path.startsWith(join(uploadDir, `${uploadId}.part`))) {
            armed = false;
            const close = file.close.bind(file);
            file.close = async () => {
              await close();
              reached.resolve();
              await release.promise;
            };
          } else if (armed && boundary === "directory-sync" && path === uploadDir && args[1] === "r") {
            armed = false;
            const sync = file.sync.bind(file);
            file.sync = async () => {
              await sync();
              reached.resolve();
              await release.promise;
            };
          }
          return file;
        };
        syncBuiltinESMExports();
        pending = patchUpload(user, uploadId, committed, Buffer.from("ab"));
        await reached.promise;
        await user.call(api.session.signOut);
        release.resolve();
        const response = await pending;
        const offset = instance.ctx.db.value<number>("SELECT offset FROM uploads WHERE id = ?", uploadId);
        instance.ctx.usage.flush();
        const uploaded = instance.ctx.db.value<number>(
          "SELECT coalesce(sum(uploaded), 0) FROM usage WHERE user_id = ?",
          userId,
        );
        const entry: Evidence = {
          case: `upload progress after signout at ${boundary}`,
          expected: 401,
          observed: response.statusCode,
          unchanged: offset === committed && uploaded === committed,
        };
        record(entry);
        assert.equal(response.statusCode, 401, response.body);
        assert.equal(offset, committed, "revoked PATCH must not advance the durable offset");
        assert.equal(uploaded, committed, "revoked PATCH must not commit uploaded-byte accounting");
        filesystem.open = actualOpen;
        syncBuiltinESMExports();
        const resumed = await patchUpload(other, uploadId, committed, Buffer.from(committed ? "RST" : "WXYZ"));
        entry.control = resumed.statusCode;
        assert.equal(resumed.statusCode, 204, resumed.body);
        await other.call(api.transfers.complete, {
          params: { id: created.id },
          body: { destination: { kind: "save" } },
        });
        const item = await other.call(api.items.get, { params: { id: created.itemId } });
        const node = item.nodes.find((value) => value.kind === "file")!;
        const content = await other.raw({ method: "GET", url: `/api/nodes/${node.id}/content` });
        assert.equal(content.statusCode, 200);
        assert.equal(
          content.body,
          committed ? "QRST" : "WXYZ",
          "new authorized bytes must replace the uncommitted tail",
        );
      } finally {
        release.resolve();
        filesystem.open = actualOpen;
        syncBuiltinESMExports();
        await pending?.catch(() => {});
        await instance.close();
      }
    });
  }
});

test("account lifecycle: guest transfer authority ends with grant, request or owner availability", async (t) => {
  for (const revocation of ["grant-expiry", "request-expiry", "request-close", "owner-disable"] as const) {
    await t.test(revocation, async () => {
      const instance = await start();
      try {
        const administrator = await admin(instance);
        const owner = await member(instance, `guest-${revocation}`, administrator);
        const ownerId = (await owner.call(api.session.get)).user.id;
        const intake = await owner.call(api.requests.create, {
          body: { id: crypto.randomUUID(), name: "Audit intake", description: "", days: 1, maxBytes: 100 },
        });
        const guest = new Client(instance);
        await guest.call(api.requests.start, { params: { token: intake.token } });
        const transfer = await guest.call(api.requests.transfer, {
          params: { token: intake.token },
          body: manifest(guest),
        });
        if (revocation === "grant-expiry")
          instance.ctx.db.run("UPDATE guest_grants SET expires = ? WHERE request_id = ?", Date.now() - 1, intake.id);
        else if (revocation === "request-expiry")
          instance.ctx.db.run("UPDATE requests SET expires = ? WHERE id = ?", Date.now() - 1, intake.id);
        else if (revocation === "request-close") await owner.call(api.requests.close, { params: { id: intake.id } });
        else await administrator.call(api.admin.updateMember, { params: { id: ownerId }, body: { disabled: true } });
        const response = await guest.raw({
          method: "POST",
          url: api.transfers.complete.path.replace(":id", transfer.id),
          payload: { destination: { kind: "save" } },
        });
        const state = instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", transfer.id);
        record({
          case: `guest transfer completion after ${revocation}`,
          expected: 404,
          observed: response.statusCode,
          unchanged: state !== "complete",
        });
        assert.equal(response.statusCode, 404, response.body);
        assert.notEqual(state, "complete");
      } finally {
        await instance.close();
      }
    });
  }
});

function localRequest(dir: string, token: string) {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      { socketPath: join(dir, SOCKETS.relay), path: "/api/local/check", headers: { [LOCAL_TOKEN_HEADER]: token } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
test("account lifecycle: local helper tokens obey expiry, signout, reset and account disable", async () => {
  const udp = createSocket("udp4");
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const port = (udp.address() as { port: number }).port;
  await new Promise<void>((resolve) => udp.close(() => resolve()));
  const instance = await start({ local: { port } });
  try {
    await instance.app.ready();
    const administrator = await admin(instance);
    const dir = instance.ctx.local!.dir!;
    for (const revocation of ["expiry", "signout", "reset", "disable"] as const) {
      const user = await member(instance, `local-${revocation}`, administrator);
      const userId = (await user.call(api.session.get)).user.id;
      const hash = sessionHash(user);
      const token = instance.ctx.secrets.localToken(hash);
      assert.equal(await localRequest(dir, token), 200);
      if (revocation === "expiry") expire(instance, hash);
      else if (revocation === "signout") await user.call(api.session.signOut);
      else if (revocation === "reset")
        await administrator.call(api.admin.resetPassword, {
          params: { id: userId },
          body: { password: "Local-reset-password" },
        });
      else await administrator.call(api.admin.updateMember, { params: { id: userId }, body: { disabled: true } });
      const status = await localRequest(dir, token);
      record({ case: `local helper token after ${revocation}`, expected: 401, observed: status, control: 200 });
      assert.equal(status, 401);
    }
  } finally {
    await instance.close();
  }
});
