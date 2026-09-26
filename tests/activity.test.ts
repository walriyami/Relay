import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_DAYS } from "../server/modules/activity/index.ts";
import { api } from "../shared/api.ts";
import type { ActivityEntry } from "../shared/model.ts";
import { admin, ApiError, Client, member, patchUpload, start } from "./support/harness.ts";

const DAY = 86_400_000;
const kinds = (entries: ActivityEntry[]) => entries.map((e) => e.kind);
const feed = (client: Client) => client.call(api.activity.list);

test("sign-ins and password changes are recorded, and a device never sees its own as news", async () => {
  const instance = await start();
  try {
    const laptop = await member(instance, "ana");
    let { entries } = await feed(laptop);
    assert.deepEqual(
      entries.map((e) => [e.kind, e.kind === "signin" && e.method, e.self]),
      [["signin", "invitation", true]],
      "joining signs the first device in",
    );

    const phone = new Client(instance);
    await phone.signIn("ana", "Member-password-only", "Phone");
    ({ entries } = await feed(laptop));
    const [latest] = entries;
    assert.equal(latest.kind, "signin");
    assert.ok(latest.kind === "signin" && latest.device === "Phone" && latest.method === "password");
    assert.equal(latest.self, false, "another device signing in is news here");
    assert.equal((await feed(phone)).entries[0].self, true, "but not on the device that signed in");

    await phone.call(api.account.password, {
      body: { current: "Member-password-only", password: "Another-password-only" },
    });
    ({ entries } = await feed(phone));
    assert.equal(entries[0].kind, "password");
    assert.ok(entries[0].kind === "password" && entries[0].device === "Phone");
    assert.equal(entries[0].self, true);

    const boss = await admin(instance);
    const { id } = await phone.call(api.session.get).then((me) => me.user);
    await boss.call(api.admin.resetPassword, { params: { id }, body: { password: "Reset-by-the-admin" } });
    const again = new Client(instance);
    await again.signIn("ana", "Reset-by-the-admin", "Tablet");
    ({ entries } = await feed(again));
    assert.deepEqual(kinds(entries).slice(0, 2), ["signin", "password"]);
    assert.ok(entries[1].kind === "password" && entries[1].device === null, "the administrator set it");
    assert.equal(entries[1].self, false);

    // The inviter hears that someone joined, with the note the invitation had.
    const { token } = await boss.call(api.admin.invite, { body: { note: "For Ben" } });
    await new Client(instance).call(api.session.join, {
      body: { token, username: "ben", password: "Member-password-only", deviceName: "Ben laptop" },
    });
    const joined = (await feed(boss)).entries.find((e) => e.kind === "joined");
    assert.ok(joined && joined.kind === "joined");
    assert.deepEqual([joined.username, joined.note], ["ben", "For Ben"]);
    assert.equal(
      (await feed(again)).entries.some((e) => e.kind === "joined"),
      false,
      "only the inviter hears it",
    );
  } finally {
    await instance.close();
  }
});

test("files sent to a request are recorded for its owner", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "cai");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Tax papers", description: "", days: 5, maxBytes: 1000 },
    });
    const guest = new Client(instance);
    await guest.call(api.requests.start, { params: { token: request.token } });
    const transfer = await guest.call(api.requests.transfer, {
      params: { token: request.token },
      body: {
        id: crypto.randomUUID(),
        tab: guest.tab,
        folders: [],
        sender: "Dana",
        files: [
          { path: "a.pdf", size: 3, mime: "application/pdf" },
          { path: "b.pdf", size: 4, mime: "application/pdf" },
        ],
      },
    });
    for (const [i, upload] of transfer.uploads.entries())
      assert.equal((await patchUpload(guest, upload.id, 0, Buffer.alloc(i ? 4 : 3))).statusCode, 204);
    assert.equal((await feed(owner)).entries[0].kind, "signin", "nothing is recorded before it completes");
    await guest.call(api.transfers.complete, { params: { id: transfer.id }, body: { destination: { kind: "save" } } });

    const [entry] = (await feed(owner)).entries;
    assert.equal(entry.kind, "upload");
    assert.ok(entry.kind === "upload");
    assert.deepEqual(
      [entry.request, entry.requestId, entry.sender, entry.files, entry.bytes, entry.text, entry.itemId],
      ["Tax papers", request.id, "Dana", 2, 7, false, transfer.itemId],
    );
    assert.equal(entry.self, false);
  } finally {
    await instance.close();
  }
});

test("the feed shows only the groups the member wants, and keeps the rest for later", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "eli");
    await new Client(instance).signIn("eli", "Member-password-only", "Phone");
    assert.deepEqual(kinds((await feed(client)).entries), ["signin", "signin"]);

    const { prefs } = await client.call(api.account.update, { body: { prefs: { activity: { security: false } } } });
    assert.deepEqual(prefs.activity, { received: true, requests: true, links: true, security: false, members: true });
    assert.deepEqual((await feed(client)).entries, []);
    await client.call(api.account.update, { body: { prefs: { activity: { security: true } } } });
    assert.deepEqual(kinds((await feed(client)).entries), ["signin", "signin"]);
  } finally {
    await instance.close();
  }
});

test("seen is shared by the account's devices, only moves forward, and never past now", async () => {
  const instance = await start();
  try {
    const laptop = await member(instance, "fay");
    const phone = new Client(instance);
    await phone.signIn("fay", "Member-password-only", "Phone");
    const other = await member(instance, "gus");

    assert.equal((await feed(laptop)).seen, 0);
    const newest = (await feed(laptop)).entries[0].created;
    await laptop.call(api.activity.seen, { body: { until: newest } });
    assert.equal((await feed(phone)).seen, newest, "seeing it on one device sees it on all");
    await phone.call(api.activity.seen, { body: { until: newest - 1000 } });
    assert.equal((await feed(laptop)).seen, newest, "never moves back");
    const before = Date.now();
    await laptop.call(api.activity.seen, { body: { until: before + 365 * DAY } });
    const { seen } = await feed(laptop);
    assert.ok(seen >= before && seen <= Date.now(), "capped at the server's now");
    assert.equal((await feed(other)).seen, 0, "another member is unaffected");
    assert.ok((await feed(other)).entries.every((e) => e.kind === "signin" && e.device === "gus browser"));

    const anonymous = await new Client(instance).raw({ method: "GET", url: "/api/activity" });
    assert.equal(anonymous.statusCode, 401);
    await assert.rejects(
      new Client(instance).call(api.activity.seen, { body: { until: 1 } }),
      (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 403),
    );
  } finally {
    await instance.close();
  }
});

test("the sweep deletes activity older than its retention", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "hal");
    assert.equal((await feed(client)).entries.length, 1);
    instance.ctx.activity.sweep(Date.now() + (ACTIVITY_DAYS - 1) * DAY);
    assert.equal((await feed(client)).entries.length, 1);
    instance.ctx.activity.sweep(Date.now() + (ACTIVITY_DAYS + 1) * DAY);
    assert.deepEqual((await feed(client)).entries, []);
  } finally {
    await instance.close();
  }
});
