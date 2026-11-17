// A finished file tells its owner and administrators, not every member with Relay open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import { admin, member, patchUpload, start } from "./support/harness.ts";

test("a finished file updates its owner and administrators, and leaves other members alone", async () => {
  const instance = await start();
  try {
    const adminClient = await admin(instance);
    const sender = await member(instance, "sam", adminClient);
    await member(instance, "bea", adminClient);
    const id = (username: string) =>
      instance.ctx.db.value<string>("SELECT id FROM users WHERE username = ?", username)!;
    const heard = new Map<string, string[]>();
    for (const username of ["admin", "sam", "bea"]) {
      heard.set(username, []);
      instance.ctx.events.subscribe(id(username), (topics) => heard.get(username)!.push(...topics));
    }
    const data = Buffer.alloc(4096, 7);
    const created = await sender.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: sender.tab,
        name: null,
        folders: [],
        files: [{ path: "a.bin", size: data.length, mime: "" }],
      },
    });
    // Reserving space changes what everyone can still upload, so everyone hears about that.
    instance.ctx.events.flush();
    assert.ok(heard.get("bea")!.includes("account"));
    for (const topics of heard.values()) topics.length = 0;

    assert.equal((await patchUpload(sender, created.uploads[0].id, 0, data)).statusCode, 204);
    instance.ctx.events.flush();
    assert.deepEqual(heard.get("sam")!.sort(), ["account", "items"]);
    assert.deepEqual(heard.get("admin"), ["account"]);
    assert.deepEqual(heard.get("bea"), [], "the other member's free space did not change");
  } finally {
    await instance.close();
  }
});
