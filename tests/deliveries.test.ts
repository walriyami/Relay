import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { DAY_MS } from "../server/lib/time.ts";
import { streamsOf } from "../server/modules/auth/streams.ts";
import { api, urls } from "../shared/api.ts";
import { ApiError, Client, member, patchUpload, send, start } from "./support/harness.ts";

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

async function setup() {
  const instance = await start();
  const laptop = await member(instance, "vera");
  const phone = new Client(instance);
  const phoneMe = await phone.signIn("vera", "Member-password-only", "Phone");
  const laptopMe = await laptop.call(api.session.get);
  const base = await instance.app.listen({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    const cookie = [...phone.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const req = request(
      base + urls.events(phone.tab) + `&browser=${phone.tab}`,
      { agent: false, headers: { cookie, host: "relay.test" } },
      (res) => {
        res.once("data", () => resolve());
        res.resume();
      },
    );
    req.on("error", reject);
    req.end();
  });
  return { instance, laptop, phone, phoneDevice: phoneMe.device.id, laptopDevice: laptopMe.device.id };
}

test("a delivery waits on the receiving device until it is accepted, and says so only once", async () => {
  const { instance, laptop, phone, phoneDevice, laptopDevice } = await setup();
  try {
    const { result } = await send(laptop, [{ path: "photo.jpg", data: "jpeg bytes", mime: "image/jpeg" }]);
    const id = crypto.randomUUID();
    const delivery = await laptop.call(api.deliveries.create, {
      body: { id, item: result.itemId, device: phoneDevice },
    });
    assert.equal(delivery.state, "available");
    assert.equal(delivery.available, true);
    assert.deepEqual(delivery.from, { id: laptopDevice, name: "vera browser" });
    assert.deepEqual(delivery.to, { id: phoneDevice, name: "Phone" });
    assert.equal(delivery.item?.id, result.itemId);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM links"), 0, "no public link is involved");

    const again = await laptop.call(api.deliveries.create, { body: { id, item: result.itemId, device: phoneDevice } });
    assert.equal(again.id, id);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM deliveries"), 1);
    assert.equal(
      await status(laptop.call(api.deliveries.create, { body: { id, item: result.itemId, device: laptopDevice } })),
      409,
    );

    const incoming = await phone.call(api.deliveries.list, { query: { direction: "incoming" } });
    assert.deepEqual(
      incoming.map((d) => d.id),
      [id],
    );
    assert.deepEqual(await laptop.call(api.deliveries.list, { query: { direction: "incoming" } }), []);
    assert.deepEqual(
      (await laptop.call(api.deliveries.list, { query: { direction: "sent" } })).map((d) => d.id),
      [id],
    );

    // The recipient opens it with its own member access.
    const [node] = (await phone.call(api.items.get, { params: { id: result.itemId } })).nodes;
    const content = await phone.raw({ method: "GET", url: urls.nodeContent(node.id) });
    assert.equal(content.body, "jpeg bytes");

    // Only the receiving device answers, once; the sender sees the answer and when it came.
    assert.equal(
      await status(laptop.call(api.deliveries.update, { params: { id }, body: { state: "accepted" } })),
      404,
    );
    assert.equal(incoming[0].answered, null);
    const before = Date.now();
    assert.deepEqual(await phone.call(api.deliveries.update, { params: { id }, body: { state: "accepted" } }), {
      state: "accepted",
      changed: true,
    });
    // Another tab of the same browser answering the same arrival changes nothing, so it doesn't download it again.
    assert.deepEqual(await phone.call(api.deliveries.update, { params: { id }, body: { state: "accepted" } }), {
      state: "accepted",
      changed: false,
    });
    assert.deepEqual(await phone.call(api.deliveries.update, { params: { id }, body: { state: "declined" } }), {
      state: "accepted",
      changed: false,
    });
    const [sent] = await laptop.call(api.deliveries.list, { query: { direction: "sent" } });
    assert.equal(sent.state, "accepted", "an accepted delivery stays accepted");
    assert.ok(sent.answered !== null && sent.answered >= before);
    // Answered deliveries stay listed on the receiving device (Activity shows them), and the item stays in Files.
    assert.deepEqual(
      (await phone.call(api.deliveries.list)).map((d) => [d.id, d.state]),
      [[id, "accepted"]],
    );
    assert.equal((await phone.call(api.items.get, { params: { id: result.itemId } })).id, result.itemId);
  } finally {
    await instance.close();
  }
});

test("a declined delivery keeps its item and can still be accepted later", async () => {
  const { instance, laptop, phone, phoneDevice } = await setup();
  try {
    const { result } = await send(laptop, [{ path: "a.txt", data: "a" }]);
    const id = crypto.randomUUID();
    await laptop.call(api.deliveries.create, { body: { id, item: result.itemId, device: phoneDevice } });
    assert.deepEqual(await phone.call(api.deliveries.update, { params: { id }, body: { state: "declined" } }), {
      state: "declined",
      changed: true,
    });
    let [sent] = await laptop.call(api.deliveries.list, { query: { direction: "sent" } });
    assert.equal(sent.state, "declined");
    assert.equal((await laptop.call(api.items.get, { params: { id: result.itemId } })).trashed, null);
    assert.deepEqual(await phone.call(api.deliveries.update, { params: { id }, body: { state: "accepted" } }), {
      state: "accepted",
      changed: true,
    });
    [sent] = await laptop.call(api.deliveries.list, { query: { direction: "sent" } });
    assert.equal(sent.state, "accepted");
    assert.equal(
      await status(
        phone.call(api.deliveries.update, { params: { id: crypto.randomUUID() }, body: { state: "accepted" } }),
      ),
      404,
    );
  } finally {
    await instance.close();
  }
});

test("incoming deliveries retain pending/answered history without displacing the complete bounded account feed", async () => {
  const { instance, laptop, phone, phoneDevice } = await setup();
  try {
    const { result } = await send(laptop, [{ path: "kept.txt", data: "kept" }]);
    const { user } = await phone.call(api.session.get);
    for (let index = 0; index < 100; index++)
      instance.ctx.activity.record(user.id, {
        kind: "upload",
        requestId: "fixture-request",
        request: `Account documents ${index}`,
        sender: null,
        itemId: result.itemId,
        files: 1,
        bytes: 4,
        text: false,
      });
    const account = await phone.call(api.activity.list);
    assert.equal(account.entries.length, 100);
    const pending: string[] = [];
    const answered: string[] = [];
    const started = Date.now() - 10_000;
    for (let index = 0; index < 202; index++) {
      const id = crypto.randomUUID();
      await laptop.call(api.deliveries.create, { body: { id, item: result.itemId, device: phoneDevice } });
      // A deterministic order puts every waiting arrival behind the answered history.
      instance.ctx.db.run("UPDATE deliveries SET created = ? WHERE id = ?", started + index, id);
      if (index < 101) pending.push(id);
      else {
        answered.push(id);
        await phone.call(api.deliveries.update, {
          params: { id },
          body: { state: index % 2 ? "accepted" : "declined" },
        });
      }
    }

    const incoming = await phone.call(api.deliveries.list, { query: { direction: "incoming" } });
    assert.equal(incoming.length, 201);
    assert.deepEqual(
      incoming.filter((delivery) => delivery.state === "available").map((delivery) => delivery.id),
      pending.toReversed(),
    );
    assert.deepEqual(
      incoming.filter((delivery) => delivery.state !== "available").map((delivery) => delivery.id),
      answered.slice(1).toReversed(),
    );
    assert.equal(
      incoming.some((delivery) => delivery.id === answered[0]),
      false,
    );
    assert.ok(incoming.every((delivery, index) => index === 0 || incoming[index - 1].created >= delivery.created));
    const stillComplete = await phone.call(api.activity.list);
    assert.deepEqual(stillComplete.entries, account.entries, "all 100 account events survive 201 incoming rows");
    await phone.call(api.activity.seen, { body: { until: account.entries[0].sequence } });
    assert.equal((await phone.call(api.activity.list)).seen, account.entries[0].sequence);
    assert.deepEqual(
      await phone.call(api.deliveries.list, { query: { direction: "incoming" } }),
      incoming,
      "marking account history does not answer or remove a waiting delivery",
    );
  } finally {
    await instance.close();
  }
});

test("deliveries need the owner's own signed-in device and a live item", async () => {
  const { instance, laptop, phone, phoneDevice } = await setup();
  try {
    const { result } = await send(laptop, [{ path: "a.txt", data: "a" }]);
    const create = (client: Client, device: string, item = result.itemId) =>
      status(client.call(api.deliveries.create, { body: { id: crypto.randomUUID(), item, device } }));

    const stranger = await member(instance, "walt");
    const strangerDevice = (await stranger.call(api.session.get)).device.id;
    assert.equal(await create(laptop, strangerDevice), 404);
    assert.equal(await create(stranger, phoneDevice), 404, "cannot deliver to someone else's device");
    const { result: theirs } = await send(stranger, [{ path: "b.txt", data: "b" }]);
    assert.equal(await create(laptop, phoneDevice, theirs.itemId), 404);

    // Trashed items disappear from the receiving device and cannot be sent.
    await laptop.call(api.deliveries.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, device: phoneDevice },
    });
    await laptop.call(api.items.trash, { params: { id: result.itemId } });
    assert.deepEqual(await phone.call(api.deliveries.list), []);
    const [sent] = await laptop.call(api.deliveries.list, { query: { direction: "sent" } });
    assert.equal(sent.available, false);
    assert.equal(await create(laptop, phoneDevice), 410);

    const { result: fresh } = await send(laptop, [{ path: "c.txt", data: "c" }]);
    await phone.call(api.session.signOut);
    assert.equal(await create(laptop, phoneDevice, fresh.itemId), 409);
  } finally {
    await instance.close();
  }
});

test("a transfer can finish as a delivery to a device", async () => {
  const { instance, laptop, phone, phoneDevice } = await setup();
  try {
    const { result } = await send(laptop, [{ path: "notes.md", data: "# notes" }], {
      text: "see attached",
      destination: { kind: "device", device: phoneDevice },
    });
    assert.ok(result.delivery);
    assert.equal(result.delivery.to?.id, phoneDevice);
    const incoming = await phone.call(api.deliveries.list);
    assert.deepEqual(
      incoming.map((d) => d.itemId),
      [result.itemId],
    );
    assert.equal(incoming[0].item?.texts, 1);
  } finally {
    await instance.close();
  }
});

test("offline devices reject new deliveries but preserve idempotent retries", async () => {
  const { instance, laptop, phoneDevice } = await setup();
  try {
    const { result } = await send(laptop, [{ path: "saved.txt", data: "saved" }]);
    const body = { id: crypto.randomUUID(), item: result.itemId, device: phoneDevice };
    const delivered = await laptop.call(api.deliveries.create, { body });
    streamsOf(instance.ctx).closeAll();
    assert.equal(streamsOf(instance.ctx).online(phoneDevice), false);
    assert.deepEqual(await laptop.call(api.deliveries.create, { body }), delivered);
    await assert.rejects(
      laptop.call(api.deliveries.create, { body: { ...body, id: crypto.randomUUID() } }),
      (error: unknown) =>
        error instanceof ApiError && error.status === 409 && error.message === "409 That device is not online.",
    );
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM deliveries"), 1);
    assert.equal((await laptop.call(api.items.get, { params: { id: result.itemId } })).id, result.itemId);
  } finally {
    await instance.close();
  }
});

test("a device going offline during upload never loses the saved file or claims delivery", async () => {
  const { instance, laptop, phoneDevice } = await setup();
  try {
    const transfer = await laptop.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: laptop.tab,
        name: null,
        folders: [],
        files: [{ path: "saved.txt", size: 5, mime: "text/plain" }],
      },
    });
    assert.equal((await patchUpload(laptop, transfer.uploads[0].id, 0, Buffer.from("saved"))).statusCode, 204);
    streamsOf(instance.ctx).closeAll();
    assert.equal(
      await status(
        laptop.call(api.transfers.complete, {
          params: { id: transfer.id },
          body: { destination: { kind: "device", device: phoneDevice } },
        }),
      ),
      409,
    );
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM deliveries"), 0);
    const saved = await laptop.call(api.items.get, { params: { id: transfer.itemId } });
    const res = await laptop.raw({ method: "GET", url: urls.nodeContent(saved.nodes[0].id) });
    assert.equal(res.body, "saved");
    await laptop.call(api.transfers.complete, { params: { id: transfer.id }, body: { destination: { kind: "save" } } });
  } finally {
    await instance.close();
  }
});

test("a pending delivery disappears exactly at content expiry, returns on restore, and is removed on purge", async (t) => {
  const { instance, laptop, phone, phoneDevice } = await setup();
  try {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const { result } = await send(laptop, [{ path: "recover.txt", data: "recover me" }]);
    const item = result.itemId;
    await laptop.call(api.items.update, { params: { id: item }, body: { retentionDays: 1 } });
    const end = now + DAY_MS;
    const id = crypto.randomUUID();
    await laptop.call(api.deliveries.create, { body: { id, item, device: phoneDevice } });
    now = end - 1;
    assert.deepEqual(
      (await phone.call(api.deliveries.list)).map((d) => d.id),
      [id],
    );
    now = end;
    assert.deepEqual(await phone.call(api.deliveries.list), []);
    const [sent] = await laptop.call(api.deliveries.list, { query: { direction: "sent" } });
    assert.equal(sent.available, false);
    assert.equal(await status(phone.call(api.deliveries.update, { params: { id }, body: { state: "accepted" } })), 410);
    await instance.ctx.library.sweep(now);
    assert.deepEqual(await phone.call(api.deliveries.list), []);
    await laptop.call(api.items.restore, { params: { id: item } });
    const [restored] = await phone.call(api.deliveries.list);
    assert.equal(restored.id, id);
    assert.equal(restored.available, true);
    assert.equal(restored.state, "available");
    assert.equal((await phone.call(api.items.get, { params: { id: item } })).nodes.length, 1);
    await phone.call(api.deliveries.update, { params: { id }, body: { state: "accepted" } });
    await laptop.call(api.items.trash, { params: { id: item } });
    assert.deepEqual(
      await phone.call(api.deliveries.update, { params: { id }, body: { state: "accepted" } }),
      {
        state: "accepted",
        changed: false,
      },
      "an acknowledged delivery retry remains idempotent after its content is gone",
    );
    await laptop.call(api.items.remove, { params: { id: item } });
    assert.deepEqual(await phone.call(api.deliveries.list), []);
    assert.deepEqual(await laptop.call(api.deliveries.list, { query: { direction: "sent" } }), []);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM deliveries WHERE id = ?", id), 0);
  } finally {
    await instance.close();
  }
});
