import { test } from "node:test";
import assert from "node:assert/strict";
import { Operations } from "../server/lib/operations.ts";
import { api } from "../shared/api.ts";
import { admin, member, Client, send, start } from "./support/harness.ts";

test("diagnostics are bounded to the last hour and never retain request details", () => {
  const ops = new Operations();
  ops.response(500, 60_000);
  ops.response(429, 3_660_000);
  ops.response(200, 3_660_000);
  assert.deepEqual(ops.snapshot(3_660_000).recent, { requests: 2, failures: 0, limited: 1 });
  assert.deepEqual(ops.snapshot(7_260_000).recent, { requests: 0, failures: 0, limited: 0 });
});

test("maintenance failure is visible, does not skip later jobs, and recovers on retry", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const original = instance.ctx.library.sweep.bind(instance.ctx.library);
    const activity = instance.ctx.activity.sweep.bind(instance.ctx.activity);
    let ran = false;
    instance.ctx.library.sweep = () => {
      throw new Error("secret/private/path");
    };
    instance.ctx.activity.sweep = (now) => {
      ran = true;
      return activity(now);
    };
    await instance.sweep();
    assert.equal(ran, true);
    const failed = await boss.call(api.admin.overview);
    const job = failed.operations.maintenance.find((s) => s.name === "Library retention")!;
    assert.equal(job.failed, true);
    assert.equal(job.failures, 1);
    assert.equal(JSON.stringify(failed).includes("secret/private/path"), false);
    instance.ctx.library.sweep = original;
    await instance.sweep();
    const recovered = await boss.call(api.admin.overview);
    assert.equal(recovered.operations.maintenance.find((s) => s.name === job.name)!.failed, false);
    assert.equal(recovered.operations.maintenance.find((s) => s.name === job.name)!.failures, 1);
  } finally {
    await instance.close();
  }
});

test("operator diagnostics remain admin-only and distinguish deduplication from Trash usage", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const user = await member(instance, "diagnostics-member", boss);
    const first = await send(user, [{ path: "one.txt", data: Buffer.from("same bytes") }]);
    await send(user, [{ path: "two.txt", data: Buffer.from("same bytes") }]);
    await user.call(api.items.trash, { params: { id: first.result.itemId } });
    const overview = await boss.call(api.admin.overview);
    assert.equal(overview.storage.used, 20);
    assert.equal(overview.storage.blobBytes, 10);
    assert.equal(overview.storage.trashBytes, 10);
    assert.equal(overview.storage.trashItems, 1);
    assert.equal((await user.raw({ method: "GET", url: "/api/admin" })).statusCode, 403);
    assert.equal((await new Client(instance).raw({ method: "GET", url: "/api/admin" })).statusCode, 401);
    assert.deepEqual((await instance.app.inject("/api/health")).json(), { ok: true, status: "healthy" });
  } finally {
    await instance.close();
  }
});
