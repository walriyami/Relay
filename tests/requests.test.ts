import { test } from "node:test";
import assert from "node:assert/strict";
import { api, urls } from "../shared/api.ts";
import { LIMITS } from "../shared/model.ts";
import { sha256 } from "../server/lib/secrets.ts";
import { ApiError, Client, admin, member, patchUpload, send, start, type Instance } from "./support/harness.ts";

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

async function setup(limits = { maxBytes: 100 }) {
  const instance = await start();
  const owner = await member(instance, "xena");
  const request = await owner.call(api.requests.create, {
    body: { id: crypto.randomUUID(), name: "Tax papers", description: "Scans please", days: 5, ...limits },
  });
  return { instance, owner, request };
}

test("request pickup codes resolve only to an open request route", async () => {
  const { instance, owner, request } = await setup();
  try {
    assert.match(request.code, /^\d{3}-\d{3}$/);
    const stored = instance.ctx.db.get<{ token_hash: string; code_hash: string }>(
      "SELECT token_hash, code_hash FROM requests WHERE id = ?",
      request.id,
    )!;
    assert.equal(stored.token_hash, sha256(request.token));
    assert.equal(stored.code_hash, instance.ctx.secrets.pickupCodeHash(request.code.replace("-", "")));
    assert.deepEqual(
      await new Client(instance).call(api.pickup.resolve, { body: { code: request.code.toLowerCase() } }),
      { kind: "request", path: `/r/${request.token}` },
    );
    await owner.call(api.requests.close, { params: { id: request.id } });
    assert.equal(
      await status(new Client(instance).call(api.pickup.resolve, { body: { code: request.code } })),
      410,
      "closing the request invalidates its pickup code",
    );
  } finally {
    await instance.close();
  }
});

async function guest(instance: Instance, token: string) {
  const client = new Client(instance);
  const grant = await client.call(api.requests.start, { params: { token } });
  assert.equal(client.csrf, grant.csrf);
  return client;
}

const files = (...sizes: number[]) =>
  sizes.map((size, i) => ({ path: `scan-${i}-${size}.pdf`, size, mime: "application/pdf" }));
const startTransfer = (
  client: Client,
  token: string,
  list: ReturnType<typeof files>,
  extra: { id?: string; sender?: string; folders?: string[] } = {},
) =>
  client.call(api.requests.transfer, {
    params: { token },
    body: { id: crypto.randomUUID(), tab: client.tab, folders: [], files: list, ...extra },
  });

async function upload(client: Client, created: { id: string; uploads: { id: string }[] }, sizes: number[]) {
  for (const [i, u] of created.uploads.entries()) {
    const res = await patchUpload(client, u.id, 0, Buffer.alloc(sizes[i], i + 1));
    assert.equal(res.statusCode, 204, res.body);
  }
  return client.call(api.transfers.complete, { params: { id: created.id }, body: { destination: { kind: "save" } } });
}

test("a request is bounded by size alone; a fixed entry guard stops empty-file floods", async () => {
  const { instance, owner, request } = await setup({ maxBytes: 100 });
  try {
    const visitor = await guest(instance, request.token);
    const many = Array.from({ length: 400 }, (_, i) => ({ path: `a/b/empty-${i}.txt`, size: 0, mime: "text/plain" }));
    const first = await startTransfer(visitor, request.token, many);
    await upload(
      visitor,
      first,
      many.map(() => 0),
    );
    const shown = await visitor.call(api.requests.open, { params: { token: request.token } });
    assert.deepEqual([shown.remainingBytes, shown.full], [100, false], "any number of files fits the size limit");

    // Fill the guard to one entry short, as a flood of empty files would.
    const held = instance.ctx.db.value<number>("SELECT COUNT(*) FROM nodes WHERE item = ?", first.itemId)!;
    instance.ctx.db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO nodes(id, item, owner, name, kind, state, created, position)
       SELECT lower(hex(randomblob(16))), ?, owner, 'flood-' || i, 'folder', 'ready', 0, 1000 + i FROM n, items WHERE items.id = ?`,
      LIMITS.requestEntries - held - 1,
      first.itemId,
      first.itemId,
    );
    const tooMany = await startTransfer(visitor, request.token, files(1, 1)).catch((e: ApiError) => e);
    assert.ok(tooMany instanceof ApiError && tooMany.status === 413);
    assert.match(tooMany.message, /This request cannot take that many more files\.$/);
    await upload(visitor, await startTransfer(visitor, request.token, files(1)), [1]);
    assert.equal((await visitor.call(api.requests.open, { params: { token: request.token } })).full, true);
    assert.equal((await owner.call(api.requests.list))[0].full, true);
    const full = await startTransfer(visitor, request.token, files(1)).catch((e: ApiError) => e);
    assert.match((full as ApiError).message, /This request is full\.$/);
  } finally {
    await instance.close();
  }
});

test("guests submit within the request's limits, into independent submissions", async () => {
  const { instance, owner, request } = await setup();
  try {
    assert.equal(request.token, instance.ctx.secrets.requestToken(request.id));
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM requests WHERE token_hash = ?", request.token), 0);
    const again = await owner.call(api.requests.create, {
      body: { id: request.id, name: "Tax papers", description: "Scans please", days: 5, maxBytes: 100 },
    });
    assert.equal(again.token, request.token);

    const anonymous = new Client(instance);
    const shown = await anonymous.call(api.requests.open, { params: { token: request.token } });
    assert.deepEqual(
      {
        name: shown.name,
        owner: shown.owner,
        remainingBytes: shown.remainingBytes,
        full: shown.full,
      },
      { name: "Tax papers", owner: "xena", remainingBytes: 100, full: false },
    );
    assert.equal(await status(startTransfer(anonymous, request.token, files(1))), 401, "no grant");
    const elsewhere = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Other", description: "", days: 5, maxBytes: 100 },
    });
    const otherGuest = await guest(instance, elsewhere.token);
    assert.equal(
      await status(startTransfer(otherGuest, request.token, files(1))),
      401,
      "a grant for this request is required",
    );

    const visitor = await guest(instance, request.token);
    const first = await startTransfer(visitor, request.token, files(30, 30));
    const opened = await anonymous.call(api.requests.open, { params: { token: request.token } });
    assert.equal(opened.remainingBytes, 40, "unfinished uploads already count");
    const owned = (await owner.call(api.requests.list)).find((r) => r.id === request.id)!;
    assert.deepEqual([owned.receivedBytes, owned.usedBytes], [0, 60], "the owner sees what unfinished uploads hold");

    const tooBig = await startTransfer(visitor, request.token, files(41)).catch((e: ApiError) => e);
    assert.equal((tooBig as ApiError).status, 413, "too many bytes");
    assert.match((tooBig as ApiError).message, /This request has room for 40 bytes more\.$/);
    await upload(visitor, first, [30, 30]);
    const second = await startTransfer(visitor, request.token, files(40));
    assert.notEqual(second.itemId, first.itemId, "later transfers create independent submissions");
    await upload(visitor, second, [40]);

    const listed = (await owner.call(api.requests.list)).find((r) => r.id === request.id)!;
    assert.equal(listed.receivedFiles, 3);
    assert.equal(listed.receivedBytes, 100);
    const submissions = await owner.call(api.requests.submissions, { params: { id: request.id } });
    assert.deepEqual(submissions.map((s) => s.id).sort(), [first.itemId, second.itemId].sort());
    assert.equal(submissions.find((s) => s.id === first.itemId)!.name, "Tax papers · scan-0-30.pdf + 1 more");
    assert.equal(submissions.find((s) => s.id === second.itemId)!.name, "Tax papers · scan-0-40.pdf");
    for (const submission of submissions) {
      assert.equal(submission.sender, null);
      assert.equal(submission.requestId, request.id);
    }
    const done = await anonymous.call(api.requests.open, { params: { token: request.token } });
    assert.deepEqual([done.remainingBytes, done.full], [0, true]);
    assert.equal(listed.full, true, "no room left is shown as full");
    assert.ok(listed.lastReceived && listed.lastReceived <= Date.now());

    // Re-starting in the same browser keeps the same grant.
    const { csrf } = await visitor.call(api.requests.start, { params: { token: request.token } });
    assert.equal(csrf, visitor.csrf);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM guest_grants WHERE request_id = ?", request.id), 1);
  } finally {
    await instance.close();
  }
});

test("guest transfer retries preserve identity while new concurrent transfers leave prior shares unchanged", async () => {
  const { instance, owner, request } = await setup();
  try {
    const visitor = await guest(instance, request.token);
    const id = crypto.randomUUID();
    const first = await startTransfer(visitor, request.token, files(2), { id });
    assert.deepEqual(await startTransfer(visitor, request.token, files(2), { id }), first);
    await upload(visitor, first, [2]);
    const link = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: first.itemId, days: 1 },
    });
    const reader = new Client(instance);
    const before = await reader.call(api.links.open, { params: { token: link.token } });

    const [partial, separate] = await Promise.all([
      startTransfer(visitor, request.token, files(3, 4)),
      startTransfer(visitor, request.token, files(3)),
    ]);
    assert.equal(new Set([first.itemId, partial.itemId, separate.itemId]).size, 3);
    const retried = await startTransfer(visitor, request.token, files(2), { id });
    assert.equal(retried.itemId, first.itemId, "a completed transfer retry keeps its original item");
    assert.equal(await status(startTransfer(visitor, request.token, files(1), { id })), 409);

    assert.equal((await patchUpload(visitor, partial.uploads[0].id, 0, Buffer.alloc(3))).statusCode, 204);
    assert.equal((await patchUpload(visitor, partial.uploads[1].id, 0, Buffer.alloc(2))).statusCode, 204);
    await visitor.call(api.transfers.cancel, { params: { id: partial.id } });
    await upload(visitor, separate, [3]);

    const savedPartial = await owner.call(api.items.get, { params: { id: partial.itemId } });
    assert.deepEqual(
      savedPartial.nodes.map((node) => node.path),
      ["scan-0-3.pdf"],
    );
    assert.equal(savedPartial.nodes[0].size, 3, "cancellation preserves the completed file independently");
    assert.equal((await owner.call(api.items.get, { params: { id: separate.itemId } })).nodes.length, 1);
    assert.deepEqual(await reader.call(api.links.open, { params: { token: link.token } }), before);
    assert.deepEqual(
      (await owner.call(api.requests.submissions, { params: { id: request.id } })).map((item) => item.id).sort(),
      [first.itemId, partial.itemId, separate.itemId].sort(),
    );
  } finally {
    await instance.close();
  }
});

test("guests are isolated from each other and can never read content", async () => {
  const { instance, owner, request } = await setup({ maxBytes: 1000 });
  try {
    const { result: saved } = await send(owner, [{ path: "private.txt", data: "owner only" }]);
    const ownerNode = (await owner.call(api.items.get, { params: { id: saved.itemId } })).nodes[0];

    const alice = await guest(instance, request.token);
    const bob = await guest(instance, request.token);
    const hers = await startTransfer(alice, request.token, files(10, 10));
    const his = await startTransfer(bob, request.token, files(5));
    assert.notEqual(hers.itemId, his.itemId, "each grant has its own submission");

    // Bob cannot touch Alice's transfer.
    assert.equal((await patchUpload(bob, hers.uploads[0].id, 0, Buffer.alloc(10))).statusCode, 404);
    assert.equal(
      await status(
        bob.call(api.transfers.complete, { params: { id: hers.id }, body: { destination: { kind: "save" } } }),
      ),
      404,
    );
    assert.equal(await status(bob.call(api.transfers.cancel, { params: { id: hers.id } })), 404);
    assert.equal(await status(bob.call(api.transfers.removeUpload, { params: { id: hers.uploads[1].id } })), 404);
    await upload(alice, hers, [10, 10]);
    const [submission] = (await owner.call(api.requests.submissions, { params: { id: request.id } })).filter(
      (s) => s.id === hers.itemId,
    );
    assert.equal(submission.files, 2);

    // Guests read nothing: not the owner's items, not their own submission.
    const hersNode = (await owner.call(api.items.get, { params: { id: hers.itemId } })).nodes[0];
    for (const client of [alice, bob]) {
      for (const endpoint of [api.items.list, api.links.list, api.deliveries.list, api.requests.list, api.devices.list])
        assert.equal(await status(client.call(endpoint as typeof api.items.list)), 401);
      for (const id of [saved.itemId, hers.itemId]) {
        assert.equal(await status(client.call(api.items.get, { params: { id } })), 401);
        const zip = await client.raw({ method: "GET", url: urls.itemZip(id) });
        assert.ok([401, 404].includes(zip.statusCode), `zip ${zip.statusCode}`);
      }
      for (const node of [ownerNode, hersNode]) {
        for (const url of [urls.nodeContent(node.id), urls.nodeThumbnail(node.id)]) {
          const res = await client.raw({ method: "GET", url });
          assert.ok([401, 404].includes(res.statusCode), `${url} ${res.statusCode}`);
        }
      }
      assert.equal(await status(client.call(api.requests.submissions, { params: { id: request.id } })), 401);
    }
  } finally {
    await instance.close();
  }
});

test("closing a request cancels unfinished uploads and stops guests", async () => {
  const { instance, owner, request } = await setup({ maxBytes: 1000 });
  try {
    const visitor = await guest(instance, request.token);
    const done = await startTransfer(visitor, request.token, files(20));
    await upload(visitor, done, [20]);
    const open = await startTransfer(visitor, request.token, files(50, 50));
    assert.equal((await patchUpload(visitor, open.uploads[0].id, 0, Buffer.alloc(25))).statusCode, 204);

    await owner.call(api.requests.close, { params: { id: request.id } });
    const pending = instance.ctx.db.value("SELECT COUNT(*) FROM nodes WHERE state = 'pending'");
    assert.equal(pending, 0, "unfinished files are gone");
    const [listed] = await owner.call(api.requests.list);
    assert.equal(listed.closed, true);
    assert.equal(listed.receivedFiles, 1, "completed files stay with the owner");

    const late = await patchUpload(visitor, open.uploads[0].id, 25, Buffer.alloc(25));
    assert.ok(late.statusCode >= 400, `late upload ${late.statusCode}`);
    assert.equal(await status(new Client(instance).call(api.requests.open, { params: { token: request.token } })), 410);
    assert.equal(await status(visitor.call(api.requests.start, { params: { token: request.token } })), 410);
    assert.equal(await status(startTransfer(visitor, request.token, files(1))), 410);

    assert.equal(await status(new Client(instance).call(api.requests.open, { params: { token: "unknown" } })), 404);
    const other = await member(instance, "yuri");
    assert.equal(await status(other.call(api.requests.close, { params: { id: request.id } })), 404);
    assert.equal(await status(other.call(api.requests.submissions, { params: { id: request.id } })), 404);
  } finally {
    await instance.close();
  }
});

test("an expired request accepts nothing", async () => {
  const { instance, request } = await setup();
  try {
    const visitor = await guest(instance, request.token);
    const pending = await startTransfer(visitor, request.token, files(2));
    instance.ctx.db.run("UPDATE requests SET expires = ?", Date.now() - 1);
    assert.equal((await patchUpload(visitor, pending.uploads[0].id, 0, Buffer.alloc(2))).statusCode, 401);
    assert.equal(await status(new Client(instance).call(api.requests.open, { params: { token: request.token } })), 410);
    assert.equal(await status(visitor.call(api.requests.start, { params: { token: request.token } })), 410);
    assert.equal(await status(startTransfer(visitor, request.token, files(1))), 410);
  } finally {
    await instance.close();
  }
});

test("a disabled request owner invalidates an existing guest session", async () => {
  const { instance, owner, request } = await setup();
  try {
    const visitor = await guest(instance, request.token);
    const pending = await startTransfer(visitor, request.token, files(2));
    const boss = await admin(instance);
    const { user } = await owner.call(api.session.get);
    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: true } });
    assert.equal((await patchUpload(visitor, pending.uploads[0].id, 0, Buffer.alloc(2))).statusCode, 401);
    assert.equal(await status(visitor.call(api.requests.start, { params: { token: request.token } })), 410);
    assert.equal(await status(startTransfer(visitor, request.token, files(1))), 410);
  } finally {
    await instance.close();
  }
});

test("request creation retries must match every form field", async () => {
  const { instance, owner, request } = await setup();
  try {
    const body = {
      id: request.id,
      name: request.name,
      description: request.description,
      days: 5,
      maxBytes: 100,
    };
    assert.deepEqual(await owner.call(api.requests.create, { body }), request);
    for (const difference of [{ name: "Other" }, { description: "Other" }, { days: 6 }, { maxBytes: 101 }]) {
      assert.equal(await status(owner.call(api.requests.create, { body: { ...body, ...difference } })), 409);
    }
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM requests"), 1);
  } finally {
    await instance.close();
  }
});

test("a deleted request keeps its pickup assignment retired and its id unavailable", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "request-history");
    const id = crypto.randomUUID();
    const body = {
      id,
      name: "Historical request",
      description: "",
      days: 7,
      maxBytes: 100,
    };
    const request = await owner.call(api.requests.create, { body });
    instance.ctx.db.run("DELETE FROM requests WHERE id = ?", id);

    assert.ok(instance.ctx.db.value("SELECT retired FROM pickup_codes WHERE kind = 'request' AND target_id = ?", id));
    assert.equal(await status(owner.call(api.requests.create, { body })), 409);
    assert.equal(await status(new Client(instance).call(api.pickup.resolve, { body: { code: request.code } })), 404);
  } finally {
    await instance.close();
  }
});

for (const removed of ["trashed", "expired"] as const) {
  test(`guest can submit again after their submission is ${removed}`, async () => {
    const { instance, owner, request } = await setup({ maxBytes: 1000 });
    try {
      const visitor = await guest(instance, request.token);
      const first = await startTransfer(visitor, request.token, files(2));
      await upload(visitor, first, [2]);
      if (removed === "trashed") await owner.call(api.items.trash, { params: { id: first.itemId } });
      else instance.ctx.db.run("UPDATE items SET expires = ? WHERE id = ?", Date.now() - 1, first.itemId);
      const next = await startTransfer(visitor, request.token, files(3));
      assert.notEqual(next.itemId, first.itemId);
      await upload(visitor, next, [3]);
      const more = await startTransfer(visitor, request.token, files(4));
      assert.notEqual(more.itemId, next.itemId);
      await upload(visitor, more, [4]);
      assert.deepEqual(
        (await owner.call(api.requests.submissions, { params: { id: request.id } })).map((i) => i.id).sort(),
        [next.itemId, more.itemId].sort(),
      );
    } finally {
      await instance.close();
    }
  });
}

test("submissions are named after the guest, or after what they sent", async () => {
  const { instance, owner, request } = await setup({ maxBytes: 1000 });
  try {
    const dana = await guest(instance, request.token);
    const hers = await startTransfer(dana, request.token, files(1, 2), { sender: "  Dana\u202e Q.\n " });
    await upload(dana, hers, [1, 2]);
    // A later submission from the same browser keeps its own name.
    const more = await startTransfer(dana, request.token, files(3), { sender: "Someone else" });
    assert.notEqual(more.itemId, hers.itemId);
    await upload(dana, more, [3]);

    const anonymous = await guest(instance, request.token);
    const theirs = await startTransfer(anonymous, request.token, [], { folders: ["Receipts"], sender: "   " });
    await anonymous.call(api.transfers.complete, {
      params: { id: theirs.id },
      body: { destination: { kind: "save" } },
    });
    const folder = await guest(instance, request.token);
    const nested = await startTransfer(folder, request.token, [
      { path: "W-2.pdf", size: 1, mime: "" },
      { path: "Receipts/a.pdf", size: 1, mime: "" },
    ]);
    await upload(folder, nested, [1, 1]);

    const submissions = await owner.call(api.requests.submissions, { params: { id: request.id } });
    const byId = new Map(submissions.map((s) => [s.id, s]));
    assert.deepEqual(
      [byId.get(hers.itemId)!.name, byId.get(hers.itemId)!.sender],
      ["Tax papers · Dana Q.", "Dana Q."],
      "trimmed, one line, no direction controls",
    );
    assert.deepEqual([byId.get(theirs.itemId)!.name, byId.get(theirs.itemId)!.sender], ["Tax papers · Receipts", null]);
    assert.deepEqual(
      [byId.get(more.itemId)!.name, byId.get(more.itemId)!.sender],
      ["Tax papers · Someone else", "Someone else"],
    );
    assert.equal(byId.get(nested.itemId)!.name, "Tax papers · W-2.pdf + 1 more");

    const tooLong = await guest(instance, request.token);
    assert.equal(
      await status(startTransfer(tooLong, request.token, files(1), { sender: "x".repeat(81) })),
      400,
      "the name is bounded",
    );
  } finally {
    await instance.close();
  }
});

test("a long request name and guest name still fit the item name limit", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "xena");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "R".repeat(180), description: "", days: 5, maxBytes: 100 },
    });
    const visitor = await guest(instance, request.token);
    const created = await startTransfer(visitor, request.token, files(1), { sender: "N".repeat(80) });
    await upload(visitor, created, [1]);
    const [submission] = await owner.call(api.requests.submissions, { params: { id: request.id } });
    assert.equal(submission.name.length, 180);
    assert.ok(submission.name.startsWith("R".repeat(180)));
  } finally {
    await instance.close();
  }
});

test("the owner's request list says when a request is full and when a guest last finished", async () => {
  const { instance, owner, request } = await setup({ maxBytes: 20 });
  try {
    const listed = async () => (await owner.call(api.requests.list)).find((r) => r.id === request.id)!;
    assert.deepEqual([(await listed()).full, (await listed()).lastReceived], [false, null]);
    const visitor = await guest(instance, request.token);
    const first = await startTransfer(visitor, request.token, files(10));
    assert.equal((await listed()).lastReceived, null, "an unfinished submission is not announced");
    await upload(visitor, first, [10]);
    const once = await listed();
    assert.equal(once.full, false);
    assert.ok(once.lastReceived);

    // The owner's own uploads never count as a guest submission.
    await send(owner, [{ path: "mine.txt", data: "x" }]);
    assert.equal((await listed()).lastReceived, once.lastReceived);

    const second = await startTransfer(visitor, request.token, files(10));
    await upload(visitor, second, [10]);
    const filled = await listed();
    assert.equal(filled.full, true, "the size limit is used up");
    assert.ok(filled.lastReceived! >= once.lastReceived);
  } finally {
    await instance.close();
  }
});

const DAY = 86_400_000;
const edits = (request: { name: string; description: string; maxBytes: number }) => ({
  name: request.name,
  description: request.description,
  days: null as number | null,
  maxBytes: request.maxBytes,
});

test("a guest browser session resumes an upload after the request's original deadline is extended", async (t) => {
  const { instance, owner, request } = await setup();
  try {
    const originalDeadline = Date.now() + 5000;
    instance.ctx.db.run("UPDATE requests SET expires = ? WHERE id = ?", originalDeadline, request.id);
    const visitor = new Client(instance);
    const session = await visitor.raw({
      method: api.requests.start.method,
      url: api.requests.start.path.replace(":token", request.token),
    });
    assert.equal(session.statusCode, 200);
    visitor.csrf = session.json<{ csrf: string }>().csrf;
    assert.equal(session.cookies.length, 1);
    assert.doesNotMatch(String(session.headers["set-cookie"]), /max-age=|expires=/i);
    const originalCookies = new Map(visitor.cookies);
    const originalCsrf = visitor.csrf;
    const pending = await startTransfer(visitor, request.token, files(2));
    assert.equal((await patchUpload(visitor, pending.uploads[0].id, 0, Buffer.alloc(1))).statusCode, 204);

    await owner.call(api.requests.update, { params: { id: request.id }, body: { ...edits(request), days: 1 } });
    t.mock.timers.enable({ apis: ["Date"], now: originalDeadline + 1 });
    assert.equal((await patchUpload(visitor, pending.uploads[0].id, 1, Buffer.alloc(1))).statusCode, 204);
    const completed = await visitor.call(api.transfers.complete, {
      params: { id: pending.id },
      body: { destination: { kind: "save" } },
    });
    assert.equal(completed.itemId, pending.itemId);

    const reopened = await visitor.raw({
      method: api.requests.start.method,
      url: api.requests.start.path.replace(":token", request.token),
    });
    assert.equal(reopened.statusCode, 200);
    assert.equal(reopened.json<{ csrf: string }>().csrf, originalCsrf);
    assert.deepEqual(visitor.cookies, originalCookies);
    assert.doesNotMatch(String(reopened.headers["set-cookie"]), /max-age=|expires=/i);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM guest_grants WHERE request_id = ?", request.id), 1);
  } finally {
    t.mock.timers.reset();
    await instance.close();
  }
});

test("editing a request changes it in place: same link and code, guests see it, uploads keep going", async () => {
  const { instance, owner, request } = await setup({ maxBytes: 100 });
  try {
    const visitor = await guest(instance, request.token);
    const pending = await startTransfer(visitor, request.token, files(30));
    const events: string[] = [];
    const userId = (await owner.call(api.session.get)).user.id;
    instance.ctx.events.flush();
    const unsubscribe = instance.ctx.events.subscribe(userId, (topics) => events.push(...topics));

    const before = Date.now();
    const edited = await owner.call(api.requests.update, {
      params: { id: request.id },
      body: { name: "Tax papers 2025", description: "PDFs only", days: 30, maxBytes: 500 },
    });
    instance.ctx.events.flush();
    unsubscribe();
    assert.deepEqual(
      [edited.id, edited.token, edited.code, edited.created],
      [request.id, request.token, request.code, request.created],
      "the link, code and history stay",
    );
    assert.deepEqual([edited.name, edited.description, edited.maxBytes], ["Tax papers 2025", "PDFs only", 500]);
    assert.ok(edited.expires >= before + 30 * DAY && edited.expires <= Date.now() + 30 * DAY, "counted from now");
    assert.deepEqual(edited.usedBytes, 30, "unfinished uploads are part of what it holds");
    assert.ok(events.includes("requests"), "the owner's other devices hear about it");
    assert.deepEqual((await owner.call(api.requests.list))[0], edited);

    const shown = await new Client(instance).call(api.requests.open, { params: { token: request.token } });
    assert.deepEqual(
      [shown.name, shown.description, shown.maxBytes, shown.remainingBytes, shown.expires],
      ["Tax papers 2025", "PDFs only", 500, 470, edited.expires],
    );
    assert.equal(
      instance.ctx.db.value("SELECT expires FROM guest_grants WHERE request_id = ?", request.id),
      edited.expires,
      "a guest's grant lasts exactly as long as the request",
    );
    await upload(visitor, pending, [30]);
    await upload(visitor, await startTransfer(visitor, request.token, files(400)), [400]);

    // Null keeps the closing time; shortening it is allowed too.
    const renamed = await owner.call(api.requests.update, {
      params: { id: request.id },
      body: { ...edits(edited), name: "Renamed" },
    });
    assert.deepEqual([renamed.name, renamed.expires], ["Renamed", edited.expires]);
    const shortened = await owner.call(api.requests.update, {
      params: { id: request.id },
      body: { ...edits(renamed), days: 1 },
    });
    assert.ok(shortened.expires < renamed.expires);
    const submission = (await owner.call(api.requests.submissions, { params: { id: request.id } })).find(
      (item) => item.id === pending.itemId,
    )!;
    assert.equal(submission.name, "Tax papers · scan-0-30.pdf", "received submissions keep their names");
  } finally {
    await instance.close();
  }
});

test("a request's size limit can't go below what it holds, unfinished uploads included", async () => {
  const { instance, owner, request } = await setup({ maxBytes: 100 });
  try {
    const visitor = await guest(instance, request.token);
    await upload(visitor, await startTransfer(visitor, request.token, files(20)), [20]);
    await startTransfer(visitor, request.token, files(30));
    const tooSmall = await owner
      .call(api.requests.update, { params: { id: request.id }, body: { ...edits(request), maxBytes: 49 } })
      .catch((e: ApiError) => e);
    assert.equal((tooSmall as ApiError).status, 409);
    assert.match((tooSmall as ApiError).message, /already holds 50 bytes\. Choose a size limit of at least that\.$/);

    // Exactly what it holds is allowed, and makes the request full.
    const full = await owner.call(api.requests.update, {
      params: { id: request.id },
      body: { ...edits(request), maxBytes: 50 },
    });
    assert.equal(full.full, true);
    assert.equal(await status(startTransfer(visitor, request.token, files(1))), 413);
    // Raising the limit again makes room.
    const raised = await owner.call(api.requests.update, {
      params: { id: request.id },
      body: { ...edits(request), maxBytes: 60 },
    });
    assert.equal(raised.full, false);
    await startTransfer(visitor, request.token, files(10));
  } finally {
    await instance.close();
  }
});

test("only the owner edits an open or expired request; closed requests are final", async () => {
  const { instance, owner, request } = await setup();
  try {
    const stranger = await member(instance, "yuri");
    const body = edits(request);
    assert.equal(await status(stranger.call(api.requests.update, { params: { id: request.id }, body })), 404);
    assert.equal(
      await status(new Client(instance).call(api.requests.update, { params: { id: request.id }, body })),
      401,
    );
    for (const invalid of [{ name: "  " }, { maxBytes: 0 }, { days: 0 }, { description: "x".repeat(2001) }])
      assert.equal(
        await status(owner.call(api.requests.update, { params: { id: request.id }, body: { ...body, ...invalid } })),
        400,
      );
    await owner.call(api.requests.close, { params: { id: request.id } });
    const closed = await owner
      .call(api.requests.update, { params: { id: request.id }, body: { ...body, days: 7 } })
      .catch((e: ApiError) => e);
    assert.equal((closed as ApiError).status, 410);
    assert.equal((await owner.call(api.requests.list))[0].name, request.name, "nothing changed");
  } finally {
    await instance.close();
  }
});

test("an expired request reopens with the same link and code, or a new code after a rotation", async () => {
  const { instance, owner, request } = await setup();
  try {
    const expire = () =>
      instance.ctx.db.run("UPDATE requests SET expires = ? WHERE id = ?", Date.now() - 1, request.id);
    expire();
    const visitor = new Client(instance);
    assert.equal(await status(visitor.call(api.requests.open, { params: { token: request.token } })), 410);
    const stillExpired = await owner
      .call(api.requests.update, { params: { id: request.id }, body: { ...edits(request), name: "Renamed" } })
      .catch((e: ApiError) => e);
    assert.equal((stillExpired as ApiError).status, 409, "renaming alone can't leave it expired and changed");
    assert.match((stillExpired as ApiError).message, /Choose how long it stays open to reopen it\.$/);

    const reopened = await owner.call(api.requests.update, {
      params: { id: request.id },
      body: { ...edits(request), days: 7 },
    });
    assert.deepEqual([reopened.token, reopened.code], [request.token, request.code]);
    assert.deepEqual(await visitor.call(api.pickup.resolve, { body: { code: request.code } }), {
      kind: "request",
      path: `/r/${request.token}`,
    });
    const grant = await guest(instance, request.token);
    await upload(grant, await startTransfer(grant, request.token, files(5)), [5]);

    // A code rotation while it is expired retires its code; reopening issues a new one.
    expire();
    await (await admin(instance)).call(api.admin.settings, { body: { codeLength: 4 } });
    assert.equal((await owner.call(api.requests.list))[0].code, "", "an expired request shows no code");
    const again = await owner.call(api.requests.update, {
      params: { id: request.id },
      body: { ...edits(request), days: 1 },
    });
    assert.match(again.code, /^\d{4}$/);
    assert.equal(again.token, request.token);
    assert.equal(await status(visitor.call(api.pickup.resolve, { body: { code: request.code } })), 404);
    assert.deepEqual(await visitor.call(api.pickup.resolve, { body: { code: again.code } }), {
      kind: "request",
      path: `/r/${request.token}`,
    });
  } finally {
    await instance.close();
  }
});
