import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import type { HistoryEntry } from "../shared/model.ts";
import { admin, ApiError, Client, member, send, start } from "./support/harness.ts";

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

/** Each entry as "kind username", oldest first, to compare against the order things happened. */
const story = (entries: HistoryEntry[]) =>
  entries.map((e) => `${e.kind} ${"username" in e ? (e.username ?? "?") : e.area}`).reverse();

test("history records who joined, changed and left, and what members sent and shared", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const ivy = await member(instance, "ivy", boss);
    const leo = await member(instance, "leo", boss);
    const { user: ivyUser } = await ivy.call(api.session.get);
    const { user: leoUser } = await leo.call(api.session.get);

    const { result } = await send(ivy, [{ path: "a.bin", data: Buffer.alloc(300, 1) }]);
    const link = { id: crypto.randomUUID(), item: result.itemId, days: 7 };
    await ivy.call(api.links.create, { body: link });
    await ivy.call(api.links.create, { body: link }); // Saving the same link again isn't a new share.
    await boss.call(api.admin.updateMember, { params: { id: ivyUser.id }, body: { admin: true } });
    await boss.call(api.admin.updateMember, { params: { id: leoUser.id }, body: { disabled: true } });
    await boss.call(api.admin.updateMember, { params: { id: leoUser.id }, body: { disabled: false } });
    await boss.call(api.admin.removeMember, { params: { id: leoUser.id } });

    const { entries, more } = await boss.call(api.admin.history, { query: {} });
    assert.equal(more, false);
    assert.deepEqual(story(entries), [
      "joined admin",
      "joined ivy",
      "joined leo",
      "sent ivy",
      "shared ivy",
      "role ivy",
      "suspended leo",
      "restored leo",
      "removed leo",
    ]);
    const byKind = Object.fromEntries(entries.map((e) => [e.kind, e]));
    const ivyJoined = entries.find((e) => e.kind === "joined" && e.username === "ivy")!;
    assert.deepEqual(
      { ...ivyJoined, id: 0, created: 0, last: 0 },
      {
        kind: "joined",
        username: "ivy",
        via: "invitation",
        by: "admin",
        userId: ivyUser.id,
        count: 1,
        id: 0,
        created: 0,
        last: 0,
      },
    );
    assert.deepEqual(
      [byKind.sent.kind === "sent" && byKind.sent.to, byKind.sent.kind === "sent" && byKind.sent.bytes],
      ["files", 300],
    );
    assert.equal(byKind.role.kind === "role" && byKind.role.admin, true);
    assert.equal(byKind.removed.userId, null, "a removed member's id is gone");
    assert.equal(byKind.removed.kind === "removed" && byKind.removed.items, 0, "leo had nothing stored");
    assert.equal(
      entries.some((e) => e.userId === leoUser.id),
      false,
      "nothing still points at the removed account",
    );
    assert.ok(
      entries.every((e) => !JSON.stringify(e).includes("a.bin")),
      "file names are never recorded",
    );
  } finally {
    await instance.close();
  }
});

test("repeated failed sign-ins become one entry, and history can be filtered and paged", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const ivy = await member(instance, "ivy", boss);
    const { user } = await ivy.call(api.session.get);
    const stranger = new Client(instance);
    for (let i = 0; i < 3; i++) assert.equal(await status(stranger.signIn("ivy", "Not-her-password")), 401);
    assert.equal(await status(stranger.signIn("nobody", "Not-a-password")), 401);
    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: true } });
    assert.equal(await status(stranger.signIn("ivy", "Member-password-only")), 403);

    const signins = await boss.call(api.admin.history, { query: { group: "signin" } });
    assert.deepEqual(
      signins.entries.map((e) => [e.kind === "signin" && e.reason, e.kind === "signin" && e.username, e.count]),
      [
        ["suspended", "ivy", 1],
        ["password", null, 1],
        ["password", "ivy", 3],
      ],
    );
    assert.ok(
      signins.entries.every((e) => !JSON.stringify(e).includes("nobody")),
      "a username that doesn't exist isn't written down",
    );

    const ivys = await boss.call(api.admin.history, { query: { member: user.id } });
    assert.deepEqual(story(ivys.entries), ["joined ivy", "signin ivy", "suspended ivy", "signin ivy"]);
    const people = await boss.call(api.admin.history, { query: { group: "people", member: user.id } });
    assert.deepEqual(story(people.entries), ["joined ivy", "suspended ivy"]);

    const first = await boss.call(api.admin.history, { query: { limit: 2 } });
    assert.equal(first.entries.length, 2);
    assert.equal(first.more, true);
    const all = await boss.call(api.admin.history, { query: { limit: 50 } });
    assert.deepEqual(
      first.entries.map((e) => e.id),
      all.entries.slice(0, 2).map((e) => e.id),
      "newest first",
    );
    assert.equal(await status(boss.call(api.admin.history, { query: { limit: 501 } })), 400);
  } finally {
    await instance.close();
  }
});

test("only administrators can read the history", async () => {
  const instance = await start();
  try {
    const ivy = await member(instance, "ivy");
    assert.equal(await status(ivy.call(api.admin.history, { query: {} })), 403);
    assert.equal(await status(new Client(instance).call(api.admin.history, { query: {} })), 401);
  } finally {
    await instance.close();
  }
});
