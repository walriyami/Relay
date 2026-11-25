// A request is checked before Relay reads its body, and again once the body has arrived: a sender
// who was signed out, suspended or lost a role while the body was on its way acts for no one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { api } from "../shared/api.ts";
import { admin, Client, member, send, start, type Instance } from "./support/harness.ts";

/**
 * Starts a JSON request whose body is held back until `release` is called; `length: false` sends it
 * without declaring its length.
 */
function held(client: Client, method: "PATCH" | "POST", url: string, body: unknown, { length = true } = {}) {
  const json = Buffer.from(JSON.stringify(body));
  const stream = new PassThrough();
  stream.write(json.subarray(0, 1));
  const pending = client.raw({
    method,
    url,
    headers: { "content-type": "application/json", ...(length ? { "content-length": String(json.length) } : {}) },
    payload: stream,
  });
  return {
    /** Sends the rest of the body and waits for the answer. */
    release: async () => {
      stream.end(json.subarray(1));
      const res = await pending;
      return { status: res.statusCode, error: res.json<{ error?: string }>().error };
    },
  };
}

// Long enough for the request to pass its early check and wait for the rest of its body.
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function secondAdmin(instance: Instance, username: string) {
  const a = await admin(instance);
  const b = await member(instance, username, a);
  const id = instance.ctx.db.value<string>("SELECT id FROM users WHERE username = ?", username)!;
  await a.call(api.admin.updateMember, { params: { id }, body: { admin: true } });
  return { a, b, id };
}

test("an administrator demoted and suspended while their body arrives can't restore themselves", async () => {
  const instance = await start();
  try {
    const { a, b, id } = await secondAdmin(instance, "heldadmin");
    const h = held(b, "PATCH", `/api/admin/members/${id}`, { admin: true, disabled: false });
    await tick();
    await a.call(api.admin.updateMember, { params: { id }, body: { admin: false } });
    await a.call(api.admin.updateMember, { params: { id }, body: { disabled: true } });
    assert.deepEqual(await h.release(), { status: 401, error: "Sign in to continue." });
    const after = instance.ctx.db.get<{ admin: number; disabled: number }>(
      "SELECT admin, disabled FROM users WHERE id = ?",
      id,
    );
    assert.deepEqual({ ...after }, { admin: 0, disabled: 1 });
  } finally {
    await instance.close();
  }
});

test("an administrator demoted while their body arrives is refused as a member", async () => {
  const instance = await start();
  try {
    const { a, b, id } = await secondAdmin(instance, "heldinviter");
    const invites = instance.ctx.db.value<number>("SELECT COUNT(*) FROM invites");
    const h = held(b, "POST", "/api/admin/invites", {});
    await tick();
    await a.call(api.admin.updateMember, { params: { id }, body: { admin: false } });
    assert.deepEqual(await h.release(), { status: 403, error: "Administrator access required." });
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM invites"), invites);
  } finally {
    await instance.close();
  }
});

test("a member signed out while their body arrives makes nothing; one still signed in does", async () => {
  const instance = await start();
  try {
    const a = await admin(instance);
    const m = await member(instance, "heldmember", a);
    const other = await member(instance, "stillhere", a);
    const body = () => ({ id: crypto.randomUUID(), name: "Held", description: "", days: 5, maxBytes: 100 });
    const request = held(m, "POST", "/api/requests", body());
    // This one used to fail on a foreign key, as a server error, instead of saying to sign in. Its
    // length isn't declared, so the second check can't depend on how the body is framed.
    const code = held(m, "POST", "/api/login-codes", {}, { length: false });
    const kept = held(other, "POST", "/api/requests", body());
    await tick();
    await m.call(api.session.signOut);
    assert.deepEqual(await request.release(), { status: 401, error: "Sign in to continue." });
    assert.deepEqual(await code.release(), { status: 401, error: "Sign in to continue." });
    assert.equal((await kept.release()).status, 200);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM requests"), 1);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM login_codes"), 0);
  } finally {
    await instance.close();
  }
});

test("a guest whose grant ends while their list arrives starts no upload", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "heldowner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Scans", description: "", days: 5, maxBytes: 100 },
    });
    const guest = new Client(instance);
    await guest.call(api.requests.start, { params: { token: request.token } });
    const h = held(guest, "POST", `/api/r/${request.token}/transfers`, {
      id: crypto.randomUUID(),
      tab: guest.tab,
      folders: [],
      files: [{ path: "a.txt", size: 5, mime: "text/plain" }],
    });
    await tick();
    // The request stays open, so only the second look at the grant itself can refuse.
    instance.ctx.db.run("DELETE FROM guest_grants");
    assert.deepEqual(await h.release(), { status: 401, error: "Open the request link again to continue." });
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM transfers"), 0);
  } finally {
    await instance.close();
  }
});

test("removing a member stops deleting their files once the acting administrator loses the right", async () => {
  const instance = await start();
  try {
    const { a, b } = await secondAdmin(instance, "remover");
    const { db } = instance.ctx;
    /** Starts removing a member with a few items, and runs `meanwhile` once deleting has begun. */
    const remove = async (by: Client, username: string, meanwhile: () => void) => {
      const m = await member(instance, username, a);
      for (const name of ["a", "b", "c", "d"]) await send(m, [{ path: `${name}.txt`, data: name }]);
      const id = db.value<string>("SELECT id FROM users WHERE username = ?", username)!;
      const removal = by.call(api.admin.removeMember, { params: { id } }).then(
        () => 200,
        (error: { status: number }) => error.status,
      );
      // The removal suspends the member before deleting anything, then yields between items.
      while (!db.value("SELECT disabled FROM users WHERE id = ?", id)) await new Promise((r) => setImmediate(r));
      meanwhile();
      const status = await removal;
      assert.ok(db.value<number>("SELECT COUNT(*) FROM items WHERE owner = ?", id)! > 0, "some items are left");
      const user = db.get<{ admin: number; disabled: number }>("SELECT admin, disabled FROM users WHERE id = ?", id);
      assert.deepEqual({ ...user }, { admin: 0, disabled: 1 }, "left suspended, as a removal that stops part way is");
      assert.equal(db.value("SELECT COUNT(*) FROM history WHERE kind = 'suspended' AND user_id = ?", id), 1);
      return status;
    };
    const signedOut = () =>
      db.run("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'remover')");
    assert.equal(await remove(b, "removed1", signedOut), 401);
    const demoted = () => db.run("UPDATE users SET admin = 0 WHERE username = 'admin'");
    assert.equal(await remove(a, "removed2", demoted), 403);
  } finally {
    await instance.close();
  }
});
