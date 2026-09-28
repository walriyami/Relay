import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { api } from "../shared/api.ts";
import type { TransferCreated } from "../shared/model.ts";
import { Client, admin, member, patchUpload, start, type Instance } from "./support/harness.ts";

const state = (instance: Instance, id: string) =>
  instance.ctx.db.value<string>("SELECT state FROM transfers WHERE id = ?", id);
const part = (instance: Instance, upload: string) => join(instance.root, "uploads", `${upload}.part`);

async function guestUpload(instance: Instance, token: string) {
  const guest = new Client(instance);
  await guest.call(api.requests.start, { params: { token } });
  const transfer = await guest.call(api.requests.transfer, {
    params: { token },
    body: {
      id: crypto.randomUUID(),
      tab: guest.tab,
      folders: [],
      files: [
        { path: "saved-empty.txt", size: 0, mime: "" },
        { path: "guest.bin", size: 4, mime: "" },
      ],
    },
  });
  assert.equal((await patchUpload(guest, transfer.uploads[1].id, 0, Buffer.from("da"))).statusCode, 204);
  return { guest, transfer };
}

async function memberAppend(owner: Client, item: string, path = "owner.bin") {
  const transfer = await owner.call(api.transfers.create, {
    body: {
      id: crypto.randomUUID(),
      tab: owner.tab,
      item,
      name: null,
      folders: [],
      files: [{ path, size: 4, mime: "" }],
    },
  });
  assert.equal((await patchUpload(owner, transfer.uploads[0].id, 0, Buffer.from("da"))).statusCode, 204);
  return transfer;
}

async function setup(instance: Instance) {
  const owner = await member(instance, "request-scope");
  const request = await owner.call(api.requests.create, {
    body: { id: crypto.randomUUID(), name: "Request", description: "", days: 5, maxBytes: 100 },
  });
  const { guest, transfer } = await guestUpload(instance, request.token);
  const append = await memberAppend(owner, transfer.itemId);
  return { owner, request, guest, transfer, append };
}

async function assertScopedCancellation(instance: Instance, scenario: Awaited<ReturnType<typeof setup>>, reserved = 4) {
  const { owner, transfer, append } = scenario;
  assert.equal(state(instance, transfer.id), "cancelled");
  assert.equal(state(instance, append.id), "open");
  assert.equal(existsSync(part(instance, transfer.uploads[1].id)), false);
  assert.equal(existsSync(part(instance, append.uploads[0].id)), true);
  assert.deepEqual(
    instance.ctx.db
      .all<{ name: string }>("SELECT name FROM nodes WHERE item = ? ORDER BY name", transfer.itemId)
      .map((n) => n.name),
    ["owner.bin", "saved-empty.txt"],
  );
  assert.equal((await owner.call(api.session.get)).usage.reserved, reserved);
  assert.equal(instance.ctx.db.value("SELECT trashed FROM items WHERE id = ?", transfer.itemId), null);
}

async function finish(owner: Client, transfer: TransferCreated) {
  assert.equal((await patchUpload(owner, transfer.uploads[0].id, 2, Buffer.from("ta"))).statusCode, 204);
  await owner.call(api.transfers.complete, {
    params: { id: transfer.id },
    body: { destination: { kind: "save" } },
  });
}

test("suspending an owner preserves uploads only until the normal five-minute tab inactivity deadline", async (t) => {
  const instance = await start();
  try {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const boss = await admin(instance);
    const { owner, guest, transfer, append } = await setup(instance);
    const { user } = await owner.call(api.session.get);
    const lease = now + 5 * 60_000;
    assert.equal(instance.ctx.config.tabLeaseMs, 5 * 60_000);
    for (const client of [owner, guest])
      assert.equal(instance.ctx.db.value("SELECT lease_expires FROM tabs WHERE id = ?", client.tab), lease);

    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: true } });
    now = lease - 1;
    await instance.ctx.transfers.sweep(now);
    assert.equal(state(instance, transfer.id), "open");
    assert.equal(state(instance, append.id), "open");
    assert.equal((await boss.call(api.admin.overview)).members.find((m) => m.id === user.id)!.usage.reserved, 8);
    assert.equal(existsSync(part(instance, transfer.uploads[1].id)), true);
    assert.equal(existsSync(part(instance, append.uploads[0].id)), true);

    now = lease;
    await instance.ctx.transfers.sweep(now);
    assert.equal(state(instance, transfer.id), "cancelled");
    assert.equal(state(instance, append.id), "cancelled");
    assert.equal((await boss.call(api.admin.overview)).members.find((m) => m.id === user.id)!.usage.reserved, 0);
    assert.equal(existsSync(part(instance, transfer.uploads[1].id)), false);
    assert.equal(existsSync(part(instance, append.uploads[0].id)), false);
    assert.deepEqual(
      instance.ctx.db
        .all<{ name: string }>("SELECT name FROM nodes WHERE item = ?", transfer.itemId)
        .map((n) => n.name),
      ["saved-empty.txt"],
    );

    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: false } });
    await owner.signIn(user.username, "Member-password-only");
    assert.equal((await owner.call(api.session.get)).usage.reserved, 0);
    assert.equal((await patchUpload(owner, append.uploads[0].id, 2, Buffer.from("ta"))).statusCode, 410);
  } finally {
    await instance.close();
  }
});

test("request close and its retries cancel guest uploads while member appends remain valid", async () => {
  const instance = await start();
  try {
    const scenario = await setup(instance);
    const { owner, request, guest, transfer, append } = scenario;
    await owner.call(api.requests.close, { params: { id: request.id } });
    await assertScopedCancellation(instance, scenario);
    const later = await memberAppend(owner, transfer.itemId, "later.bin");
    await owner.call(api.requests.close, { params: { id: request.id } });
    assert.equal((await guest.raw({ method: "HEAD", url: `/uploads/${transfer.uploads[1].id}` })).statusCode, 401);
    assert.equal(state(instance, append.id), "open");
    assert.equal(state(instance, later.id), "open");
    assert.equal((await owner.call(api.session.get)).usage.reserved, 8);
    await finish(owner, append);
    await finish(owner, later);
    assert.equal((await owner.call(api.session.get)).usage.reserved, 0);
  } finally {
    await instance.close();
  }
});

for (const boundary of ["request expiry", "grant expiry", "missing grant", "closed request"] as const) {
  test(`maintenance releases ${boundary} guest reservations and preserves member appends`, async (t) => {
    const instance = await start();
    try {
      const scenario = await setup(instance);
      const { owner, request, transfer, append } = scenario;
      const other = boundary === "grant expiry" ? await guestUpload(instance, request.token) : null;
      let now = Date.now();
      t.mock.method(Date, "now", () => now);
      const end = now + 1;
      if (boundary === "request expiry")
        instance.ctx.db.run("UPDATE requests SET expires = ? WHERE id = ?", end, request.id);
      if (boundary === "grant expiry")
        instance.ctx.db.run(
          "UPDATE guest_grants SET expires = ? WHERE token_hash = (SELECT substr(principal, 7) FROM transfers WHERE id = ?)",
          end,
          transfer.id,
        );
      await instance.ctx.transfers.sweep(now);
      assert.equal(state(instance, transfer.id), "open", "deadline-1 must preserve guest uploads");
      assert.equal(state(instance, append.id), "open");
      now = end;
      if (boundary === "missing grant")
        instance.ctx.db.run(
          "DELETE FROM guest_grants WHERE token_hash = (SELECT substr(principal, 7) FROM transfers WHERE id = ?)",
          transfer.id,
        );
      if (boundary === "closed request")
        instance.ctx.db.run("UPDATE requests SET closed = ? WHERE id = ?", now, request.id);
      await instance.ctx.transfers.sweep(now);
      await assertScopedCancellation(instance, scenario, other ? 8 : 4);
      if (other) assert.equal(state(instance, other.transfer.id), "open", "the other grant is still valid");
      await finish(owner, append);
    } finally {
      await instance.close();
    }
  });
}

for (const endpoint of ["HEAD", "PATCH"] as const) {
  test(`an expired guest ${endpoint} cancels only that principal, preserving member appends and other guests`, async () => {
    const instance = await start();
    try {
      const scenario = await setup(instance);
      const { owner, request, guest, transfer, append } = scenario;
      const other = await guestUpload(instance, request.token);
      instance.ctx.db.run(
        "UPDATE guest_grants SET expires = ? WHERE token_hash = (SELECT substr(principal, 7) FROM transfers WHERE id = ?)",
        Date.now(),
        transfer.id,
      );
      const denied =
        endpoint === "HEAD"
          ? await guest.raw({ method: "HEAD", url: `/uploads/${transfer.uploads[1].id}` })
          : await patchUpload(guest, transfer.uploads[1].id, 2, Buffer.from("ta"));
      assert.equal(denied.statusCode, 401);
      assert.equal(state(instance, transfer.id), "cancelled");
      assert.equal(state(instance, append.id), "open");
      assert.equal(state(instance, other.transfer.id), "open");
      assert.equal((await owner.call(api.session.get)).usage.reserved, 8);
      await instance.ctx.transfers.sweep(Date.now());
      assert.equal(state(instance, other.transfer.id), "open", "maintenance must preserve the other valid grant");
      await finish(owner, append);
      assert.equal(
        (await patchUpload(other.guest, other.transfer.uploads[1].id, 2, Buffer.from("ta"))).statusCode,
        204,
      );
    } finally {
      await instance.close();
    }
  });
}

for (const boundary of ["Trash", "item expiry"] as const) {
  test(`${boundary} still cancels both guest uploads and member appends on the item`, async () => {
    const instance = await start();
    try {
      const { owner, guest, transfer, append } = await setup(instance);
      if (boundary === "Trash") await owner.call(api.items.trash, { params: { id: transfer.itemId } });
      else {
        instance.ctx.db.run("UPDATE items SET expires = ? WHERE id = ?", Date.now(), transfer.itemId);
        assert.equal((await guest.raw({ method: "HEAD", url: `/uploads/${transfer.uploads[1].id}` })).statusCode, 410);
      }
      assert.equal(state(instance, transfer.id), "cancelled");
      assert.equal(state(instance, append.id), "cancelled");
      assert.equal((await owner.call(api.session.get)).usage.reserved, 0);
      assert.equal(existsSync(part(instance, transfer.uploads[1].id)), false);
      assert.equal(existsSync(part(instance, append.uploads[0].id)), false);
    } finally {
      await instance.close();
    }
  });
}
