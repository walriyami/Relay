// What one request-link holder can make the server do: how much a send may list, how many sends and
// live-update streams one visitor or network may hold, and how uploads are refused when room runs out.
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { api, urls } from "../shared/api.ts";
import { DEFAULTS, LIMITS } from "../shared/model.ts";
import { GUEST_STREAMS_PER_ADDRESS } from "../server/modules/auth/streams.ts";
import { receiversOf } from "../server/modules/transfers/receivers.ts";
import { ApiError, Client, admin, member, start, type Instance } from "./support/harness.ts";
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

    // 70,000 three-byte characters fit the character count but not the byte limit.
    assert.equal(await status(sendTo(guest, request.token, [], "€".repeat(70_000))), 413);
    assert.equal(await status(sendTo(guest, request.token, [], "a\0b")), 400);
    // A type with a line break would be a header injection waiting to happen; it isn't kept.
    await sendTo(guest, request.token, [{ path: "a.bin", size: 1, mime: "text/html\r\nX-Evil: 1" }]);
    assert.equal(instance.ctx.db.value("SELECT mime FROM nodes WHERE name = 'a.bin'"), "");
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
    for (let i = 0; i < 10; i++)
      await sendTo(await visit(instance, request.token), request.token, [{ path: "a", size: 1 }]);
    const refused = await sendTo(await visit(instance, request.token), request.token, [{ path: "a", size: 1 }]).catch(
      (error: ApiError) => error,
    );
    assert.equal((refused as ApiError).status, 429);
    const elsewhere = await visit(instance, request.token, "203.0.113.9");
    assert.ok(await sendTo(elsewhere, request.token, [{ path: "a", size: 1 }]), "another network still can");
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

test("one network can hold only a few visitors' live-update streams; past that, pages ask again", async () => {
  const instance = await start();
  const base = await listen(instance);
  const streams: Stream[] = [];
  try {
    const owner = await member(instance, "streams-owner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Live", description: "", days: 5, maxBytes: 100 },
    });
    for (let i = 0; i <= GUEST_STREAMS_PER_ADDRESS; i++) {
      const guest = await visit(instance, request.token);
      const stream = await Stream.open(base, urls.guestEvents(request.token, guest.tab), guest);
      streams.push(stream);
      await stream.until((events) => events.length > 0);
    }
    const first = (stream: Stream) => stream.events[0].split("\n")[0];
    assert.ok(streams.slice(0, -1).every((stream) => first(stream) === "event: ready"));
    assert.equal(first(streams.at(-1)!), "event: limited");
  } finally {
    await Promise.all(streams.map((stream) => stream.close()));
    await instance.close();
  }
});
