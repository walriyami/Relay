import { test } from "node:test";
import assert from "node:assert/strict";
import { api, urls } from "../shared/api.ts";
import { start, admin, member, send } from "./support/harness.ts";

test("the administrator API cannot directly browse another member's private content", async () => {
  const instance = await start();
  try {
    const administrator = await admin(instance);
    const owner = await member(instance, "private-member", administrator);
    const saved = await send(owner, [{ path: "private.txt", data: "MEMBER PRIVATE CONTENT" }], {
      destination: { kind: "link", days: 1, password: "Member-controlled share password" },
    });
    const item = await owner.call(api.items.get, { params: { id: saved.result.itemId } });
    const request = await owner.call(api.requests.create, {
      body: {
        id: crypto.randomUUID(),
        name: "Private submissions",
        description: "",
        days: 1,
        maxBytes: 1024,
      },
    });
    for (const path of [
      `/api/items/${item.id}`,
      `/api/links/${saved.result.link!.id}/visits`,
      `/api/requests/${request.id}/submissions`,
      urls.nodeContent(item.nodes[0].id),
      urls.nodeThumbnail(item.nodes[0].id),
      urls.itemZip(item.id),
    ]) {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await administrator.raw({ method, url: path });
        assert.equal(response.statusCode, 404, `${method} ${path}`);
        assert.equal(response.body.includes("MEMBER PRIVATE CONTENT"), false);
      }
    }
    const share = await administrator.call(api.links.open, { params: { token: saved.result.link!.token } });
    assert.equal(share.locked, true, "administrator identity does not bypass another member's share password");
    assert.equal(
      (await administrator.raw({ url: urls.shareContent(saved.result.link!.token, item.nodes[0].id) })).statusCode,
      401,
    );
  } finally {
    await instance.close();
  }
});
