import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { api, urls } from "../shared/api.ts";
import { ApiError, Client, member, patchUpload, start } from "./support/harness.ts";

test("an item cannot be delivered until every remaining upload is saved or cancelled", async (t) => {
  const instance = await start();
  try {
    const laptop = await member(instance, "readiness");
    const phone = new Client(instance);
    const phoneMe = await phone.signIn("readiness", "Member-password-only", "Phone");
    const base = await instance.app.listen({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      const cookie = [...phone.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
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

    for (const finish of ["complete", "cancel"] as const) {
      await t.test(finish, async () => {
        const created = await laptop.call(api.transfers.create, {
          body: {
            id: crypto.randomUUID(),
            tab: laptop.tab,
            name: null,
            folders: [],
            files: [
              { path: "first.txt", size: 5, mime: "text/plain" },
              { path: "second.txt", size: 6, mime: "text/plain" },
            ],
          },
        });
        const body = { id: crypto.randomUUID(), item: created.itemId, device: phoneMe.device.id };
        const rejectPending = () =>
          assert.rejects(
            laptop.call(api.deliveries.create, { body }),
            (error: unknown) =>
              error instanceof ApiError &&
              error.status === 409 &&
              error.message === "409 Wait for the uploads to finish before sending.",
          );

        await rejectPending();
        assert.equal((await patchUpload(laptop, created.uploads[0].id, 0, Buffer.from("first"))).statusCode, 204);
        await rejectPending();
        assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM deliveries WHERE item = ?", created.itemId), 0);
        assert.equal(
          (await phone.call(api.deliveries.list)).some((delivery) => delivery.itemId === created.itemId),
          false,
        );
        const partial = await laptop.call(api.items.get, { params: { id: created.itemId } });
        assert.deepEqual(
          partial.nodes.filter((node) => node.kind === "file").map((node) => node.name),
          ["first.txt"],
        );

        if (finish === "complete") {
          assert.equal((await patchUpload(laptop, created.uploads[1].id, 0, Buffer.from("second"))).statusCode, 204);
          await laptop.call(api.transfers.complete, {
            params: { id: created.id },
            body: { destination: { kind: "save" } },
          });
        } else {
          await laptop.call(api.transfers.cancel, { params: { id: created.id } });
        }

        // The previously rejected id can now deliver the entire saved item, including after cancellation.
        const delivery = await laptop.call(api.deliveries.create, { body });
        assert.equal(delivery.state, "available");
        assert.equal(delivery.item?.uploading, false);
        assert.equal(delivery.item?.files, finish === "complete" ? 2 : 1);
        const received = await phone.call(api.items.get, { params: { id: created.itemId } });
        assert.deepEqual(
          received.nodes
            .filter((node) => node.kind === "file")
            .map((node) => node.name)
            .sort(),
          finish === "complete" ? ["first.txt", "second.txt"] : ["first.txt"],
        );
      });
    }
  } finally {
    await instance.close();
  }
});
