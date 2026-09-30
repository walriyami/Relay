import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { LANES, Mux, type Lane } from "../shared/lanes.ts";

// Two ends of a connection made of lanes, in memory: each lane delivers what's sent on it in order,
// unless it's stalled, as a lane that lost its path is.

type Wire = Lane & { stalled: boolean; held: (string | Uint8Array)[]; release(): void };

function pair(count: number) {
  const ends: { a: Mux | null; b: Mux | null } = { a: null, b: null };
  const wire = (to: () => Mux): Wire => {
    const w: Wire = {
      stalled: false,
      held: [],
      send(data) {
        const copy = typeof data === "string" ? data : data.slice();
        if (w.stalled) w.held.push(copy);
        else queueMicrotask(() => to().receive(copy));
      },
      buffered: () => 0,
      release() {
        w.stalled = false;
        for (const data of w.held.splice(0)) queueMicrotask(() => to().receive(data));
      },
    };
    return w;
  };
  const ab = Array.from({ length: count }, () => wire(() => ends.b!));
  const ba = Array.from({ length: count }, () => wire(() => ends.a!));
  const events = { control: () => {}, broken: () => assert.fail("The connection broke.") };
  ends.a = new Mux(ab[0], events, 1 << 20);
  ends.b = new Mux(ba[0], events, 1 << 20);
  for (let i = 1; i < count; i++) {
    ends.a.add(ab[i]);
    ends.b.add(ba[i]);
  }
  return { a: ends.a, b: ends.b, ab, ba };
}

/** Sends `data` as stream 1 from `from` to `to`; resolves with what arrived. */
function carry(from: Mux, to: Mux, data: Uint8Array) {
  const window = 4 * LANES.creditBytes;
  const chunks: Uint8Array[] = [];
  const arrived = new Promise<Buffer>((resolve, reject) => {
    to.incoming(1, {
      to: data.byteLength,
      window,
      write: (bytes) => void chunks.push(bytes.slice()),
      done: () => resolve(Buffer.concat(chunks)),
      failed: reject,
    });
  });
  const out = from.outgoing(1, 0, window);
  const send = () => {
    while (out.offset < data.byteLength && out.room > 0)
      out.write(data.subarray(out.offset, out.offset + Math.min(out.room, 256 * 1024)));
  };
  out.onReady = send;
  send();
  return arrived;
}

test("lanes: what a lane that lost its path carried goes again on the others", async () => {
  const { a, b, ab } = pair(4);
  const data = randomBytes(10 * LANES.creditBytes + 999);
  // Lane 2 goes quiet from the start: what's sent on it stays there.
  ab[2].stalled = true;
  const arrived = carry(a, b, data);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(ab[2].held.length > 0);
  a.remove(ab[2]);
  assert.equal(a.width, 3);
  assert.ok((await arrived).equals(data));
});

test("lanes: frames that arrive twice, once their lane finds its path again, are dropped", async () => {
  const { a, b, ab } = pair(3);
  const data = randomBytes(6 * LANES.creditBytes + 5);
  ab[1].stalled = true;
  const arrived = carry(a, b, data);
  await new Promise((resolve) => setTimeout(resolve, 10));
  a.remove(ab[1]);
  // The lane delivers everything it held after all, and carries frames again.
  ab[1].release();
  a.add(ab[1]);
  assert.equal(a.width, 3);
  assert.ok((await arrived).equals(data));
});

test("lanes: the first lane can't be taken out of use", () => {
  const { a, ab } = pair(2);
  a.remove(ab[0]);
  assert.equal(a.width, 2);
});

test("lanes: a lane that throws when sent on is taken out of use, and its frame goes on another", async () => {
  const { a, b, ab } = pair(3);
  const data = randomBytes(3 * LANES.creditBytes);
  ab[2].send = () => {
    throw new Error("closed");
  };
  assert.ok((await carry(a, b, data)).equals(data));
  assert.equal(a.width, 2);
});
