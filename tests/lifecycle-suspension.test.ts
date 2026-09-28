import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import { ApiError, Client, admin, member, patchUpload, send, start } from "./support/harness.ts";

test("suspension preserves valid handoffs while tightened deadlines continue and remain final", async (t) => {
  const instance = await start();
  try {
    const owner = await member(instance, "reviewer");
    const boss = await admin(instance);
    const { user } = await owner.call(api.session.get);
    const now = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now });
    const { result } = await send(owner, [], { text: "review", destination: { kind: "link", days: 3 } });
    assert.ok(result.link);
    const link = result.link;
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Review", description: "", days: 5, maxBytes: 100 },
    });
    const visitor = new Client(instance);
    await visitor.call(api.requests.start, { params: { token: request.token } });
    const guestCookies = [...visitor.cookies];
    const beginGuest = () =>
      visitor.call(api.requests.transfer, {
        params: { token: request.token },
        body: {
          id: crypto.randomUUID(),
          tab: visitor.tab,
          folders: [],
          files: [{ path: "review.txt", size: 1, mime: "text/plain" }],
        },
      });
    const denied = (promise: Promise<unknown>) =>
      assert.rejects(
        promise,
        (error: unknown) => error instanceof ApiError && [401, 403, 404, 410].includes(error.status),
      );
    await visitor.call(api.links.open, { params: { token: link.token } });
    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: true } });
    await denied(visitor.call(api.links.open, { params: { token: link.token } }));
    await denied(visitor.call(api.requests.open, { params: { token: request.token } }));
    await denied(beginGuest());

    t.mock.timers.setTime(now + 1_000);
    await boss.call(api.admin.updateMember, {
      params: { id: user.id },
      body: { limits: { storage: null, keepDays: null, linkDays: 1 }, expectedLimits: user.limits },
    });
    const deadline = now + 1_000 + 86_400_000;
    assert.equal(instance.ctx.db.value("SELECT expires FROM links WHERE id = ?", link.id), deadline);
    assert.equal(instance.ctx.db.value("SELECT expires FROM requests WHERE id = ?", request.id), deadline);
    assert.equal(instance.ctx.db.value("SELECT expires FROM guest_grants WHERE request_id = ?", request.id), deadline);
    assert.equal(instance.ctx.db.value("SELECT revoked FROM links WHERE id = ?", link.id), null);
    assert.equal(instance.ctx.db.value("SELECT closed FROM requests WHERE id = ?", request.id), null);

    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: false } });
    await visitor.call(api.links.open, { params: { token: link.token } });
    await visitor.call(api.requests.open, { params: { token: request.token } });
    await visitor.call(api.pickup.resolve, { body: { code: link.code } });
    await visitor.call(api.pickup.resolve, { body: { code: request.code } });
    assert.ok(guestCookies.every(([name, value]) => visitor.cookies.get(name) === value));
    const created = await beginGuest();
    const uploaded = await patchUpload(visitor, created.uploads[0].id, 0, Buffer.from("x"));
    assert.equal(uploaded.statusCode, 204);
    await visitor.call(api.transfers.complete, { params: { id: created.id }, body: { destination: { kind: "save" } } });

    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: true } });
    t.mock.timers.setTime(deadline);
    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: false } });
    await denied(visitor.call(api.links.open, { params: { token: link.token } }));
    await denied(visitor.call(api.requests.open, { params: { token: request.token } }));
    await denied(beginGuest());
    await denied(visitor.call(api.pickup.resolve, { body: { code: link.code } }));
    await denied(visitor.call(api.pickup.resolve, { body: { code: request.code } }));
    assert.equal(instance.ctx.db.value("SELECT expires FROM guest_grants WHERE request_id = ?", request.id), deadline);
  } finally {
    t.mock.timers.reset();
    await instance.close();
  }
});
