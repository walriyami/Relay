// What one request-link holder can make the server do: how much a send may list, how many sends and
// live-update streams one visitor or network may hold, and how uploads are refused when room runs out.
import assert from "node:assert/strict";
import { statSync, statfsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { api, urls } from "../shared/api.ts";
import { DEFAULTS, LIMITS } from "../shared/model.ts";
import { GUEST_STREAMS_PER_ADDRESS } from "../server/modules/auth/streams.ts";
import { GUEST_TABS_KEPT, UNSTARTED_GUEST_MS } from "../server/modules/transfers/lifecycle.ts";
import { OPEN_PER_NETWORK } from "../server/modules/transfers/create.ts";
import { VISITOR_SENDS, VISITS_PER_ADDRESS, VISITS_PER_NETWORK } from "../server/modules/requests/guests.ts";
import { receiversOf } from "../server/modules/transfers/receivers.ts";
import { DISK_HEADROOM } from "../server/modules/transfers/room.ts";
import { ApiError, Client, admin, member, patchUpload, start, type Instance } from "./support/harness.ts";
import type { Grant, Principal } from "../server/context.ts";
import { eventually, listen, Stream } from "./support/event-stream.ts";

const MiB = 1024 ** 2;

async function visit(instance: Instance, token: string, address?: string) {
  const client = new Client(instance);
  client.address = address;
  await client.call(api.requests.start, { params: { token } });
  return client;
}

const sendTo = (client: Client, token: string, files: { path: string; size: number; mime?: string }[], text?: string) =>
  client.call(api.requests.transfer, {
    params: { token },
    body: {
      id: crypto.randomUUID(),
      tab: client.tab,
      folders: [],
      files: files.map((f) => ({ mime: "", ...f })),
      ...(text === undefined ? {} : { text }),
    },
  });

const status = (promise: Promise<unknown>) =>
  promise.then(
    () => 200,
    (error: unknown) => {
      if (error instanceof ApiError) return error.status;
      throw error;
    },
  );

/** A PATCH over a real socket whose body the test writes piece by piece. */
function streamingPatch(base: string, client: Client, upload: string, length: number) {
  const req = httpRequest(`${base}/uploads/${upload}`, {
    method: "PATCH",
    agent: false,
    headers: {
      host: new URL(client.instance.ctx.config.origin ?? "http://localhost").host,
      cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      "x-relay-csrf": client.csrf,
      "tus-resumable": "1.0.0",
      "upload-offset": "0",
      "content-type": "application/offset+octet-stream",
      "content-length": String(length),
    },
  });
  const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
  });
  return { req, answer };
}

const arrived = (instance: Instance, upload: string) => receiversOf(instance.ctx)?.arriving().get(upload) ?? 0;

test("a visitor's send lists at most 5,000 entries; text is limited in bytes and must be storable", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "entries-owner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Many", description: "", days: 5, maxBytes: 1000 },
    });
    const guest = await visit(instance, request.token);
    const many = Array.from({ length: LIMITS.visitorEntriesPerTransfer + 1 }, (_, i) => ({
      path: `${i}.txt`,
      size: 0,
    }));
    const refused = await sendTo(guest, request.token, many).catch((error: ApiError) => error);
    assert.equal((refused as ApiError).status, 413);
    assert.match((refused as ApiError).message, /Send up to 5,000 files and folders at a time\.$/);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM nodes"), 0, "nothing was written");

    // 70,000 three-byte characters fit the character count but not a visitor's byte limit...
    assert.equal(await status(sendTo(guest, request.token, [], "€".repeat(70_000))), 413);
    // ...while members keep the limit they had.
    const mine = {
      id: crypto.randomUUID(),
      tab: owner.tab,
      name: null,
      folders: [],
      files: [],
      text: "€".repeat(70_000),
    };
    assert.ok(await owner.call(api.transfers.create, { body: mine }));
    assert.equal(await status(sendTo(guest, request.token, [], "a\0b")), 400);
    // A type with a line break would be a header injection waiting to happen; it isn't kept.
    await sendTo(guest, request.token, [{ path: "a.bin", size: 1, mime: "text/html\r\nX-Evil: 1" }]);
    assert.equal(instance.ctx.db.value("SELECT mime FROM nodes WHERE name = 'a.bin'"), "");
  } finally {
    await instance.close();
  }
});

test("a visitor's send that can't be taken is refused before its file list is planned", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "unplanned-owner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Cheap", description: "", days: 5, maxBytes: 1000 },
    });
    const guest = await visit(instance, request.token);
    // Planning this list fails (two files share a path), so whichever answer comes first shows
    // which check ran first.
    const clash = (size = 1) => [
      { path: "same", size },
      { path: "same", size },
    ];
    assert.equal(await status(sendTo(guest, request.token, clash(600))), 413, "too big for the request");
    const long = Array.from({ length: LIMITS.visitorEntriesPerTransfer }, (_, i) => ({ path: `${i}`, size: 0 }));
    assert.equal(await status(sendTo(guest, request.token, [...long, ...clash()])), 413, "too many entries");
    assert.equal(await status(sendTo(guest, request.token, clash())), 409, "planned once the cheap checks pass");
    for (let i = 0; i < 3; i++) await sendTo(guest, request.token, [{ path: "a", size: 1 }]);
    assert.equal(await status(sendTo(guest, request.token, clash())), 429, "too many open sends");
  } finally {
    await instance.close();
  }
});

test("starting new visits doesn't reset how many sends one network may hold open", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "visits-owner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Open", description: "", days: 5, maxBytes: 1000 },
    });
    const one = (address: string) =>
      visit(instance, request.token, address).then((guest) =>
        status(sendTo(guest, request.token, [{ path: "a", size: 1 }])),
      );
    // Each from its own address in one IPv4 /24, and in one IPv6 /56.
    for (let i = 1; i <= OPEN_PER_NETWORK; i++) assert.equal(await one(`198.51.100.${i}`), 200);
    assert.equal(await one("198.51.100.200"), 429, "the next address along is the same network");
    for (let i = 1; i <= OPEN_PER_NETWORK; i++) assert.equal(await one(`2001:db8:0:${i}::1`), 200);
    assert.equal(await one("2001:db8:0:ff::1"), 429, "so is another /64 in the same /56");
    assert.equal(await one("198.51.101.1"), 200, "another network still can");
    assert.equal(await one("2001:db8:0:100::1"), 200);
  } finally {
    await instance.close();
  }
});

test("cancelled sends still count towards how much a network and a link may send in an hour", async (t) => {
  // Small limits stand in for the real ones; what matters is what counts and what doesn't.
  t.mock.property(VISITOR_SENDS, "network", { sends: 3, entries: 8 });
  t.mock.property(VISITOR_SENDS, "link", { sends: 5, entries: 100 });
  const instance = await start();
  try {
    const owner = await member(instance, "send-limits-owner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Open", description: "", days: 5, maxBytes: 1000 },
    });
    const guest = await visit(instance, request.token, "198.51.100.7");
    const sendAndCancel = async (client: Client, count = 1) => {
      const sent = await sendTo(
        client,
        request.token,
        Array.from({ length: count }, (_, i) => ({ path: `f${i}`, size: 1 })),
      );
      await client.call(api.transfers.cancel, { params: { id: sent.id } });
      return sent;
    };
    // A retry of a send already made is not another send.
    const files = [{ mime: "", path: "kept", size: 1 }];
    const first = await sendTo(guest, request.token, files);
    const retried = await guest.call(api.requests.transfer, {
      params: { token: request.token },
      body: { id: first.id, tab: guest.tab, folders: [], files },
    });
    assert.equal(retried.id, first.id);
    await guest.call(api.transfers.cancel, { params: { id: first.id } });
    await sendAndCancel(guest);
    await sendAndCancel(guest);
    const refused = await guest.raw({
      method: "POST",
      url: `/api/r/${request.token}/transfers`,
      payload: { id: crypto.randomUUID(), tab: guest.tab, folders: [], files: [{ path: "a", size: 1, mime: "" }] },
    });
    assert.equal(refused.statusCode, 429);
    assert.match(refused.json<{ error: string }>().error, /from your network in the last hour/);
    assert.ok(Number(refused.headers["retry-after"]) >= 60);
    // A new visit from the same network is the same network.
    const again = await visit(instance, request.token, "198.51.100.8");
    assert.equal(await status(sendTo(again, request.token, [{ path: "a", size: 1 }])), 429);

    // Entries count as well as sends: another network may list 8 in all.
    const other = await visit(instance, request.token, "203.0.113.7");
    await sendAndCancel(other, 6);
    assert.equal(
      await status(
        sendTo(other, request.token, [
          { path: "a", size: 1 },
          { path: "b", size: 1 },
          { path: "c", size: 1 },
        ]),
      ),
      429,
    );
    // The folders a path implies are entries too: one file two folders down is three.
    assert.equal(await status(sendTo(other, request.token, [{ path: "x/y/deep", size: 1 }])), 429);
    assert.equal(
      instance.ctx.db.value(
        "SELECT entries FROM visitor_sends WHERE network = ? ORDER BY created DESC LIMIT 1",
        "203.0.113.0/24",
      ),
      6,
    );
    await sendAndCancel(other, 2);

    // Five sends in all reach the link's own limit, whichever network the next one comes from.
    const third = await visit(instance, request.token, "192.0.2.7");
    assert.equal(await status(sendTo(third, request.token, [{ path: "a", size: 1 }])), 429);

    // An hour later the limits are back.
    instance.ctx.db.run("UPDATE visitor_sends SET created = created - ?", VISITOR_SENDS.windowMs);
    assert.equal(await status(sendTo(third, request.token, [{ path: "a", size: 1 }])), 200);
    assert.equal(
      instance.ctx.db.value("SELECT count(*) FROM visitor_sends"),
      1,
      "a send clears the link's sends from before the hour",
    );
  } finally {
    await instance.close();
  }
});

test("visits without a cookie don't pile up: one device cycles through its own, and those sending stay", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "piling-owner");
    const create = (name: string) =>
      owner.call(api.requests.create, {
        body: { id: crypto.randomUUID(), name, description: "", days: 5, maxBytes: 1000 },
      });
    const file = [{ path: "a", size: 1 }];
    const visits = (requestId: string, column: "address" | "network", value: string) =>
      instance.ctx.db.value<number>(
        `SELECT count(*) FROM guest_grants WHERE request_id = ? AND ${column} = ?`,
        requestId,
        value,
      );

    // One device starting visit after visit forgets its own oldest, not its neighbour's.
    const piles = await create("Piles");
    const neighbour = await visit(instance, piles.token, "198.51.100.50");
    const busy = await visit(instance, piles.token, "198.51.100.7");
    await sendTo(busy, piles.token, file);
    for (let i = 0; i < VISITS_PER_ADDRESS + 2; i++) await visit(instance, piles.token, "198.51.100.7");
    assert.equal(visits(piles.id, "address", "198.51.100.7"), VISITS_PER_ADDRESS);
    assert.equal(await status(sendTo(busy, piles.token, file)), 200, "its visit with a send open stays");
    assert.equal(await status(sendTo(neighbour, piles.token, file)), 200, "its neighbour's stays");

    // A network full of many devices' visits forgets its oldest that isn't sending; a cancelled
    // send doesn't keep a visit.
    const crowd = await create("Crowd");
    const idle = await visit(instance, crowd.token, "198.51.100.1");
    const sending = await visit(instance, crowd.token, "198.51.100.2");
    await sendTo(sending, crowd.token, file);
    const cancelled = await visit(instance, crowd.token, "198.51.100.3");
    await cancelled.call(api.transfers.cancel, { params: { id: (await sendTo(cancelled, crowd.token, file)).id } });
    for (let i = 4; i < VISITS_PER_NETWORK + 10; i++) await visit(instance, crowd.token, `198.51.100.${i}`);
    assert.equal(visits(crowd.id, "network", "198.51.100.0/24"), VISITS_PER_NETWORK);
    assert.equal(await status(sendTo(idle, crowd.token, file)), 401);
    assert.equal(await status(sendTo(cancelled, crowd.token, file)), 401);
    assert.equal(await status(sendTo(sending, crowd.token, file)), 200);
    // Coming back is simply a new visit, and another network is untouched.
    await idle.call(api.requests.start, { params: { token: crowd.token } });
    assert.equal(await status(sendTo(idle, crowd.token, file)), 200);
    await visit(instance, crowd.token, "203.0.113.1");
    assert.equal(visits(crowd.id, "network", "203.0.113.0/24"), 1);
  } finally {
    await instance.close();
  }
});

test("closing pages a visit never used leaves only a few records", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "closing-tabs-owner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Tabs", description: "", days: 5, maxBytes: 1000 },
    });
    const guest = await visit(instance, request.token);
    for (let i = 0; i < 40; i++)
      await guest.call(api.transfers.closeTab, { params: { id: crypto.randomUUID().replaceAll("-", "") } });
    const recorded = instance.ctx.db.value<number>("SELECT count(*) FROM tabs WHERE principal LIKE 'grant:%'")!;
    assert.ok(recorded > 0 && recorded <= 8, `${recorded} tabs recorded`);
    // A member's are kept: closing first still refuses a send that was on its way.
    const tab = crypto.randomUUID().replaceAll("-", "");
    await owner.call(api.transfers.closeTab, { params: { id: tab } });
    assert.equal(instance.ctx.db.value("SELECT closed IS NOT NULL FROM tabs WHERE id = ?", tab), 1);
  } finally {
    await instance.close();
  }
});

test("a visitor's large send must really get going within ten minutes; a byte doesn't hold its room", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "going-owner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Going", description: "", days: 5, maxBytes: 64 * MiB },
    });
    const state = (sent: { id: string }) =>
      instance.ctx.db.value<string>("SELECT state FROM transfers WHERE id = ?", sent.id);
    const begin = async (guest: Client, path: string, size: number, data: string) => {
      const sent = await sendTo(guest, request.token, [{ path, size }]);
      if (data) assert.equal((await patchUpload(guest, sent.uploads[0].id, 0, Buffer.from(data))).statusCode, 204);
      return sent;
    };
    const guest = await visit(instance, request.token);
    const big = await begin(guest, "big.bin", 8 * MiB, "x");
    const small = await begin(guest, "small.bin", 4, "ab");
    const other = await visit(instance, request.token);
    const queued = await begin(other, "later.bin", 8 * MiB, "");
    const busy = await sendTo(other, request.token, [{ path: "now.bin", size: 8 * MiB }]);
    assert.equal((await patchUpload(other, busy.uploads[0].id, 0, Buffer.alloc(4 * MiB))).statusCode, 204);
    const third = await visit(instance, request.token);
    const stalled = await begin(third, "stalled.bin", 8 * MiB, "");
    const empty = await sendTo(third, request.token, [
      { path: "empty.txt", size: 0 },
      { path: "pending.bin", size: 8 * MiB },
    ]);
    const later = Date.now() + UNSTARTED_GUEST_MS + 60_000;
    // The other visitor is still sending now.bin when the sweep runs.
    instance.ctx.db.run("UPDATE uploads SET touched = ? WHERE id = ?", later, busy.uploads[0].id);
    // An empty file is finished the moment it is listed; that isn't progress.
    instance.ctx.db.run("UPDATE uploads SET touched = ? WHERE transfer = ?", later, empty.id);
    await instance.ctx.transfers.sweep(later);
    assert.notEqual(state(big), "open", "one byte of 8 MiB isn't getting going");
    assert.equal(state(small), "open", "a small send that has begun may finish");
    assert.equal(state(busy), "open", "4 MiB arrived: it is going");
    assert.equal(state(queued), "open", "its visitor is busy sending something else");
    assert.notEqual(state(stalled), "open", "a finished empty file elsewhere doesn't count as busy");
  } finally {
    await instance.close();
  }
});

test("the request page counts the server's room, so it never promises what the first byte is refused for", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const owner = await member(instance, "room-owner", boss);
    await boss.call(api.admin.settings, { body: { capacity: 1000, expectedCapacity: DEFAULTS.capacityBytes } });
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Big", description: "", days: 5, maxBytes: 5000 },
    });
    const shown = await new Client(instance).call(api.requests.open, { params: { token: request.token } });
    assert.deepEqual([shown.remainingBytes, shown.storageLimited, shown.full], [1000, true, false]);
    const roomy = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Small", description: "", days: 5, maxBytes: 100 },
    });
    const small = await new Client(instance).call(api.requests.open, { params: { token: roomy.token } });
    assert.deepEqual([small.remainingBytes, small.storageLimited], [100, false]);
  } finally {
    await instance.close();
  }
});

test("overlapping uploads can't together go past the server's capacity", async () => {
  const instance = await start();
  const base = await listen(instance);
  try {
    const boss = await admin(instance);
    const owner = await member(instance, "overlap-owner", boss);
    await boss.call(api.admin.settings, { body: { capacity: 3 * MiB, expectedCapacity: DEFAULTS.capacityBytes } });
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Big", description: "", days: 5, maxBytes: 3 * MiB },
    });
    const guest = await visit(instance, request.token);
    const sent = await sendTo(guest, request.token, [{ path: "big.bin", size: 2 * MiB }]);
    const upload = sent.uploads[0].id;
    const { req, answer } = streamingPatch(base, guest, upload, 2 * MiB);
    req.write(Buffer.alloc(64 * 1024));
    await eventually(() => arrived(instance, upload) > 0);
    // A member is admitted while the visitor's bytes are still on their way...
    const mine = await boss.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: boss.tab,
        name: null,
        folders: [],
        files: [{ path: "m", size: 2 * MiB, mime: "" }],
      },
    });
    assert.ok(mine);
    // ...so the rest of the visitor's file no longer fits, and the visitor is told so.
    req.end(Buffer.alloc(2 * MiB - 64 * 1024));
    const { status: code, body } = await answer;
    assert.equal(code, 507);
    assert.match(body, /storage capacity/);
    assert.equal(instance.ctx.db.value("SELECT offset FROM uploads WHERE id = ?", upload), 0);
  } finally {
    await instance.close();
  }
});

test("a visitor's file that just fits on the disk isn't refused for the bytes it has already written", async (t) => {
  const instance = await start();
  try {
    const owner = await member(instance, "disk-owner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Disk", description: "", days: 5, maxBytes: 4 * MiB },
    });
    const guest = await visit(instance, request.token);
    const size = 2 * MiB;
    const sent = await sendTo(guest, request.token, [{ path: "fits.bin", size }]);
    const upload = sent.uploads[0].id;
    const part = receiversOf(instance.ctx)!.partPath(upload);
    // A disk with room for this file and a little more: what the upload writes uses it up.
    const spare = size + 64 * 1024;
    const free = () => {
      const disk = statfsSync(instance.ctx.config.root);
      return disk.bavail * disk.bsize;
    };
    const written = () => {
      try {
        return statSync(part).size;
      } catch {
        return 0;
      }
    };
    t.mock.method(instance.ctx.transfers, "outstandingBytes", () => free() - DISK_HEADROOM - (spare - written()));
    const res = await patchUpload(guest, upload, 0, Buffer.alloc(size));
    assert.equal(res.statusCode, 204, res.body);
  } finally {
    await instance.close();
  }
});

test("closing a request mid-upload answers the visitor with why, instead of cutting the connection", async () => {
  const instance = await start();
  const base = await listen(instance);
  try {
    const owner = await member(instance, "closing-owner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Closing", description: "", days: 5, maxBytes: 2 * MiB },
    });
    const guest = await visit(instance, request.token);
    const sent = await sendTo(guest, request.token, [{ path: "a.bin", size: MiB }]);
    const upload = sent.uploads[0].id;
    const { req, answer } = streamingPatch(base, guest, upload, MiB);
    req.write(Buffer.alloc(64 * 1024));
    await eventually(() => arrived(instance, upload) > 0);
    await owner.call(api.requests.close, { params: { id: request.id } });
    req.end(Buffer.alloc(MiB - 64 * 1024));
    const { status: code } = await answer;
    assert.equal(code, 410);
  } finally {
    await instance.close();
  }
});

test("one network can hold only a few visitors' live-update streams per request; past that, pages ask again", async (t) => {
  const instance = await start();
  const base = await listen(instance);
  const streams: Stream[] = [];
  try {
    const owner = await member(instance, "streams-owner");
    const create = (name: string) =>
      owner.call(api.requests.create, {
        body: { id: crypto.randomUUID(), name, description: "", days: 5, maxBytes: 100 },
      });
    const request = await create("Live");
    const open = async (token: string) => {
      const guest = await visit(instance, token);
      const stream = await Stream.open(base, urls.guestEvents(token, guest.tab), guest);
      streams.push(stream);
      await stream.until((events) => events.length > 0);
      return stream.events[0].split("\n")[0];
    };
    for (let i = 0; i < GUEST_STREAMS_PER_ADDRESS; i++) assert.equal(await open(request.token), "event: ready");
    // Asking again past the cap costs no query per open stream, and leaves no record of the page.
    const tabs = () => instance.ctx.db.value<number>("SELECT count(*) FROM tabs");
    const before = tabs();
    const get = t.mock.method(instance.ctx.db, "get");
    assert.equal(await open(request.token), "event: limited");
    const grantChecks = get.mock.calls.filter((call) => String(call.arguments[0]).includes("JOIN requests r")).length;
    assert.ok(grantChecks <= 1, `${grantChecks} grant checks for one refused stream`);
    get.mock.restore();
    assert.equal(tabs(), before, "a refused stream adds no tab");
    // The same network still gets live updates on another request.
    assert.equal(await open((await create("Other")).token), "event: ready");
  } finally {
    await Promise.all(streams.map((stream) => stream.close()));
    await instance.close();
  }
});

test("a session that ended in this browser doesn't hold a new one's live updates back", async () => {
  const instance = await start();
  const base = await listen(instance);
  const streams: Stream[] = [];
  try {
    const browser = crypto.randomUUID();
    const open = async (client: Client) => {
      const stream = await Stream.open(base, urls.events(client.tab), client, browser);
      streams.push(stream);
      await stream.until((events) => events.length > 0);
      return stream.events[0].split("\n")[0];
    };
    const before = await member(instance, "before-owner");
    for (let i = 0; i < 4; i++) assert.equal(await open(before), "event: ready");
    // The session runs out; nothing has checked its streams since.
    instance.ctx.db.run("UPDATE sessions SET expires = ?", Date.now() - 1);
    const after = await member(instance, "after-owner");
    assert.equal(await open(after), "event: ready");
  } finally {
    await Promise.all(streams.map((stream) => stream.close()));
    await instance.close();
  }
});

test("a visitor naming new pages again and again keeps only a few on record", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "tab-owner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Tabs", description: "", days: 5, maxBytes: 1000 },
    });
    const guest = await visit(instance, request.token);
    const sent = await sendTo(guest, request.token, [{ path: "kept", size: 1 }]);
    const { db } = instance.ctx;
    const tokenHash = db.value<string>("SELECT token_hash FROM guest_grants WHERE request_id = ?", request.id)!;
    const grant: Grant = {
      kind: "grant",
      tokenHash,
      requestId: request.id,
      owner: "",
      itemId: null,
      csrf: "",
      expires: 0,
    };
    // As an update stream opened under a made-up page name would.
    const names = Array.from({ length: GUEST_TABS_KEPT * 3 }, () => crypto.randomUUID());
    for (const name of names) assert.equal(instance.ctx.transfers.renewTab(name, grant), true);
    const kept = (name: string) => !!db.get("SELECT 1 FROM tabs WHERE id = ?", name);
    assert.equal(db.value("SELECT count(*) FROM tabs WHERE principal = ?", `grant:${tokenHash}`), GUEST_TABS_KEPT + 1);
    assert.deepEqual(
      names.filter(kept),
      names.slice(-GUEST_TABS_KEPT),
      "the latest pages stay, and the page that sent something",
    );
    assert.ok(kept(guest.tab));
    // A page closed just now is kept over ones used before it, so a create still on its way from
    // it is refused rather than starting the page again.
    const closing = crypto.randomUUID();
    assert.equal(instance.ctx.transfers.renewTab(closing, grant), true);
    db.run("UPDATE tabs SET closed = ? WHERE id = ?", Date.now(), closing);
    assert.equal(instance.ctx.transfers.renewTab(crypto.randomUUID(), grant), true);
    assert.ok(kept(closing));
    assert.equal(instance.ctx.transfers.renewTab(closing, grant), false);
    // The page that sent goes on as before.
    await guest.call(api.transfers.cancel, { params: { id: sent.id } });
    // A member's pages are theirs to name, and aren't limited this way.
    const memberTabs = Array.from({ length: GUEST_TABS_KEPT + 4 }, () => crypto.randomUUID());
    const ownerId = db.value<string>("SELECT id FROM users WHERE username = 'tab-owner'")!;
    for (const name of memberTabs)
      instance.ctx.transfers.renewTab(name, { kind: "member", userId: ownerId } as Principal);
    assert.equal(memberTabs.filter(kept).length, memberTabs.length);
  } finally {
    await instance.close();
  }
});
