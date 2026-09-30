// Defensive regression tests for Nearby's established-link boundary. The WebRTC fixture only
// replaces local transport setup; Link, Lanes, Mux, and the transfer engine are production code.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";
import type { NearbyPeer } from "../shared/nearby.ts";
import type * as Engine from "../client/lib/nearby/engine.ts";

class LocalChannel {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  closed = false;

  send(data: string | Uint8Array) {
    if (this.closed) throw new Error("Transport is closed");
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  control(message: object) {
    if (!this.closed) this.onmessage?.({ data: JSON.stringify(message) });
  }
  bytes(stream: number, offset: number, bytes: Uint8Array) {
    const frame = new Uint8Array(12 + bytes.length);
    const header = new DataView(frame.buffer);
    header.setUint32(0, stream);
    header.setFloat64(4, offset);
    frame.set(bytes, 12);
    if (!this.closed) this.onmessage?.({ data: frame.buffer });
  }
}

class LocalPeerConnection {
  static created: LocalPeerConnection[] = [];
  channel = new LocalChannel();
  closed = false;
  localDescription: { sdp: string } | null = null;
  signalingState = "stable";
  iceGatheringState = "complete";
  ondatachannel = null;
  onconnectionstatechange = null;
  constructor() {
    LocalPeerConnection.created.push(this);
  }
  createDataChannel() {
    return this.channel;
  }
  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "local fixture" });
  }
  createAnswer() {
    return Promise.resolve({ type: "answer", sdp: "local fixture" });
  }
  setLocalDescription(description: { sdp: string; type: string }) {
    this.localDescription = description;
    this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
    return Promise.resolve();
  }
  setRemoteDescription() {
    return Promise.resolve();
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.closed = true;
    this.channel.close();
  }
}

const peer = (kind: NearbyPeer["kind"]): NearbyPeer => ({
  id: "fixture-peer",
  name: "Local peer",
  kind,
  deviceKind: "computer",
  owner: kind === "member" || kind === "host" ? "local owner" : null,
  present: true,
});

const offer = (id: string, text = 4) => ({ t: "offer", id, files: [], folders: [], text, preview: "test" });

test("Nearby rejects malformed controls and revokes established peers", async (t) => {
  // Browser modules use Vite's extensionless resolution; keep the source unchanged for Node tests.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") && !/\.[a-z]+(?:[?#].*)?$/i.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const document = Object.assign(new EventTarget(), { hidden: false });
  for (const [key, value] of Object.entries({
    window: new EventTarget(),
    document,
    navigator: {},
    RTCPeerConnection: LocalPeerConnection,
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engine: typeof Engine = await import("../client/lib/nearby/engine.ts");
  t.after(() => engine.clearEngine());

  const fixture = (context: TestContext, kind: NearbyPeer["kind"] = "guest", listed = true) => {
    engine.clearEngine();
    engine.watch(false);
    engine.setDirectory([]);
    t.mock.timers.tick(250);
    const other = peer(kind);
    engine.startEngine({ self: "fixture-self", signal: () => Promise.resolve() });
    engine.setDirectory(listed ? [other] : []);
    engine.receiveSignal(other.id, { kind: "offer", session: "fixture-session", sdp: "local fixture" });
    const pc = LocalPeerConnection.created.at(-1)!;
    pc.channel.onopen?.();
    engine.watch(true);
    context.after(() => {
      engine.watch(false);
      engine.clearEngine();
      t.mock.timers.tick(250);
    });
    return { other, pc, channel: pc.channel };
  };

  for (const kind of ["guest", "member", "host"] as const)
    await t.test(`removing a ${kind} directory entry closes its link and pending offer`, (context) => {
      const { pc, channel } = fixture(context, kind);
      channel.control(offer(`pending-${kind}`));
      t.mock.timers.tick(250);
      assert.equal(engine.nearbySnapshot().transfers[0].state, "incoming");
      assert.equal(engine.nearbySnapshot().status[peer(kind).id], "ready");

      engine.setDirectory([]); // The directory returned after removal, end-code, or hide.
      t.mock.timers.tick(250);
      const snapshot = engine.nearbySnapshot();
      assert.deepEqual(
        {
          closed: pc.closed,
          status: snapshot.status[peer(kind).id],
          pending: snapshot.transfers[0]?.state === "incoming",
        },
        { closed: true, status: undefined, pending: false },
      );
    });

  await t.test("removing a peer stops an accepted receive before further bytes are stored", async (context) => {
    const { pc, channel } = fixture(context);
    channel.control(offer("running-receive"));
    await engine.accept("running-receive");
    await setImmediate();
    engine.setDirectory([]);
    channel.bytes(0, 0, new Uint8Array([1, 2]));
    await setImmediate();
    t.mock.timers.tick(250);
    const transfer = engine.nearbySnapshot().transfers[0];
    assert.deepEqual(
      { closed: pc.closed, active: engine.isActive(transfer), moved: transfer.moved },
      { closed: true, active: false, moved: 0 },
    );
  });

  await t.test("non-string offer folders are rejected without escaping the channel callback", (context) => {
    const { channel } = fixture(context);
    assert.doesNotThrow(() => channel.control({ ...offer("invalid-folders"), folders: [42] }));
    t.mock.timers.tick(250);
    assert.equal(engine.nearbySnapshot().transfers.length, 0);
  });

  await t.test("unknown accept.have keys cannot crash later credit processing", async (context) => {
    const { other, channel } = fixture(context);
    const id = engine.send(other, [{ file: new File(["abcd"], "small.txt"), path: "small.txt" }], [], "");
    channel.control({ t: "accept", id, have: { unexpected: 1 }, stream: 0 });
    await setImmediate();
    assert.doesNotThrow(() => channel.control({ s: 0, credit: 1 }));
  });

  await t.test("an initial introduction waits for its directory entry", (context) => {
    const { other, pc, channel } = fixture(context, "guest", false);
    channel.control(offer("initial-introduction"));
    t.mock.timers.tick(1000);
    assert.equal(engine.nearbySnapshot().transfers.length, 0);
    assert.equal(pc.closed, false);
    engine.setDirectory([other]);
    t.mock.timers.tick(250);
    assert.equal(engine.nearbySnapshot().transfers[0].state, "incoming");
  });

  await t.test("a removed peer cannot return through retries, stale sends, or late signals", (context) => {
    const { other, channel } = fixture(context);
    const id = engine.send(other, [], [], "test");
    channel.onclose?.();
    t.mock.timers.tick(250);
    assert.equal(engine.nearbySnapshot().transfers.find((transfer) => transfer.id === id)?.state, "reconnecting");
    engine.setDirectory([]);
    const connections = LocalPeerConnection.created.length;
    engine.receiveSignal(other.id, { kind: "offer", session: "late-session", sdp: "local fixture" });
    engine.send(other, [], [], "stale selection");
    t.mock.timers.tick(10_000);
    assert.equal(LocalPeerConnection.created.length, connections);
    assert.equal(
      engine.nearbySnapshot().transfers.every((transfer) => transfer.state === "cancelled"),
      true,
    );
    assert.equal(Object.hasOwn(engine.nearbySnapshot().status, other.id), false);
  });

  await t.test("queued receive work cannot complete after removal", async (context) => {
    const { channel } = fixture(context);
    const notices: string[] = [];
    const release = engine.onNotice((notice) => notices.push(notice.kind));
    context.after(release);
    channel.control(offer("queued-receive"));
    await engine.accept("queued-receive");
    await setImmediate();
    channel.bytes(0, 0, new Uint8Array([1, 2, 3, 4]));
    engine.setDirectory([]); // Before the queued storage callback runs.
    await setImmediate();
    t.mock.timers.tick(250);
    const transfer = engine.nearbySnapshot().transfers[0];
    assert.equal(transfer.state, "cancelled");
    assert.equal(transfer.moved, 0);
    assert.equal(transfer.text, null);
    assert.equal(notices.includes("received"), false);
  });

  await t.test("late file assembly cannot revive a cancelled receive", async (context) => {
    const { channel } = fixture(context);
    let finish: ((text: string) => void) | undefined;
    context.mock.method(File.prototype, "text", () => new Promise<string>((resolve) => (finish = resolve)));
    channel.control(offer("finishing-receive"));
    await engine.accept("finishing-receive");
    await setImmediate();
    channel.bytes(0, 0, new TextEncoder().encode("test"));
    await setImmediate();
    assert.ok(finish, "the receive reached asynchronous text assembly");
    engine.setDirectory([]);
    finish("test");
    await setImmediate();
    t.mock.timers.tick(250);
    const transfer = engine.nearbySnapshot().transfers[0];
    assert.equal(transfer.state, "cancelled");
    assert.equal(transfer.text, null);
    assert.equal(transfer.received, null);
  });

  await t.test("a pending file read cannot send bytes after removal", async (context) => {
    const { other, channel } = fixture(context);
    let read: ((bytes: ArrayBuffer) => void) | undefined;
    context.mock.method(Blob.prototype, "arrayBuffer", () => new Promise<ArrayBuffer>((resolve) => (read = resolve)));
    const id = engine.send(other, [{ file: new File(["abcd"], "small.txt"), path: "small.txt" }], [], "");
    channel.control({ t: "accept", id, have: {}, stream: 0 });
    assert.ok(read, "the sender began reading its file");
    engine.setDirectory([]);
    read(new Uint8Array([1, 2, 3, 4]).buffer);
    await setImmediate();
    t.mock.timers.tick(250);
    assert.equal(
      channel.sent.some((frame) => typeof frame !== "string"),
      false,
    );
    assert.equal(engine.nearbySnapshot().transfers[0].state, "cancelled");
  });

  await t.test("valid controls still resume and finish a file-and-text send", async (context) => {
    const { other, channel } = fixture(context);
    const id = engine.send(other, [{ file: new File(["abcd"], "small.txt"), path: "small.txt" }], [], "ef");
    channel.control({ t: "accept", id, have: { 0: 2, text: 1 }, stream: 5 });
    await setImmediate();
    const frames = channel.sent.filter((frame): frame is Uint8Array => typeof frame !== "string");
    assert.deepEqual(
      frames.map((frame) => ({
        stream: new DataView(frame.buffer).getUint32(0),
        offset: new DataView(frame.buffer).getFloat64(4),
        size: frame.length - 12,
      })),
      [
        { stream: 5, offset: 2, size: 2 },
        { stream: 6, offset: 1, size: 1 },
      ],
    );
    channel.control({ s: 5, credit: 2 });
    channel.control({ s: 6, credit: 1 });
    channel.control({ t: "done", id });
    t.mock.timers.tick(250);
    assert.equal(engine.nearbySnapshot().transfers[0].state, "done");
    assert.equal(engine.nearbySnapshot().transfers[0].moved, 6);
  });

  await t.test("valid receives finish and stay available after their peer is removed", async (context) => {
    const { channel } = fixture(context);
    channel.control(offer("allowed-receive"));
    await engine.accept("allowed-receive");
    await setImmediate();
    channel.bytes(0, 0, new TextEncoder().encode("test"));
    await setImmediate();
    t.mock.timers.tick(250);
    assert.equal(engine.nearbySnapshot().transfers[0].state, "done");
    engine.setDirectory([]);
    t.mock.timers.tick(250);
    assert.equal(engine.nearbySnapshot().transfers[0].state, "done");
    assert.equal(engine.nearbySnapshot().transfers[0].text, "test");
  });

  await t.test("removing an own-device entry cancels its automatically accepted receive", async (context) => {
    const { pc, channel } = fixture(context, "device");
    channel.control(offer("own-device-receive"));
    await setImmediate();
    t.mock.timers.tick(250);
    assert.equal(engine.nearbySnapshot().transfers[0].state, "running");
    engine.setDirectory([]);
    t.mock.timers.tick(250);
    assert.equal(pc.closed, true);
    assert.equal(engine.nearbySnapshot().transfers[0].state, "cancelled");
  });

  await t.test("valid decline and cancel controls end only their transfer", async (context) => {
    const { pc, other, channel } = fixture(context);
    const id = engine.send(other, [], [], "test");
    channel.control({ t: "decline", id, reason: "declined" });
    channel.control(offer("cancelled-by-peer"));
    await engine.accept("cancelled-by-peer");
    channel.control({ t: "cancel", id: "cancelled-by-peer" });
    t.mock.timers.tick(250);
    const snapshot = engine.nearbySnapshot();
    assert.equal(snapshot.transfers.find((transfer) => transfer.id === id)?.state, "declined");
    assert.equal(snapshot.transfers.find((transfer) => transfer.id === "cancelled-by-peer")?.state, "cancelled");
    assert.equal(pc.closed, false);
  });

  await t.test("an accept stream range must fit every entry of the transfer", async (context) => {
    const { other, channel } = fixture(context);
    const id = engine.send(other, [{ file: new File(["abcd"], "small.txt"), path: "small.txt" }], [], "text");
    channel.control({ t: "accept", id, have: {}, stream: 2 ** 32 - 1 });
    await setImmediate();
    t.mock.timers.tick(250);
    assert.equal(engine.nearbySnapshot().transfers[0].state, "failed");
    assert.equal(
      channel.sent.some((frame) => typeof frame !== "string"),
      false,
    );
  });

  await t.test("new offers from one peer have a bounded pending queue", (context) => {
    const { channel } = fixture(context);
    for (let i = 0; i < 257; i++) channel.control(offer(`repeated-${i}`));
    t.mock.timers.tick(250);
    assert.equal(engine.nearbySnapshot().transfers.length, 8);
    // An ordinary resume for a known offer still works even when admission is full.
    channel.control(offer("repeated-0"));
    t.mock.timers.tick(250);
    assert.equal(engine.nearbySnapshot().transfers.length, 8);
  });

  await t.test("unknown introductions have a bounded held-message queue", (context) => {
    const { other, channel } = fixture(context, "guest", false);
    for (let i = 0; i < 257; i++) channel.control(offer(`held-${i}`));
    const declines = channel.sent.filter(
      (message) => typeof message === "string" && (JSON.parse(message) as { t: string }).t === "decline",
    );
    assert.equal(declines.length, 249, "excess offers are declined before the directory arrives");
    engine.setDirectory([other]);
    t.mock.timers.tick(250);
    assert.equal(engine.nearbySnapshot().transfers.length, 8);
  });

  await t.test("recent decline memory is bounded without losing recent decisions", (context) => {
    const { channel } = fixture(context);
    for (let i = 0; i < 300; i++) {
      const id = `declined-${i}`;
      channel.control(offer(id));
      engine.decline(id);
    }
    channel.control(offer("declined-0"));
    channel.control(offer("declined-299"));
    t.mock.timers.tick(250);
    assert.deepEqual(
      engine.nearbySnapshot().transfers.map((transfer) => transfer.id),
      ["declined-0"],
    );
  });

  await t.test("retained receipts are bounded and remain available when admission is full", async (context) => {
    const { channel } = fixture(context, "device");
    for (let i = 0; i < 136; i++) {
      channel.control({ ...offer(`receipt-${i}`, 0), files: [{ path: "empty.txt", size: 0, type: "", modified: 1 }] });
      await setImmediate();
    }
    t.mock.timers.tick(250);
    const snapshot = engine.nearbySnapshot();
    assert.equal(snapshot.transfers.length, 128);
    assert.equal(
      snapshot.transfers.every((transfer) => transfer.state === "done"),
      true,
    );
    assert.equal(
      snapshot.transfers.some((transfer) => transfer.id === "receipt-0"),
      true,
    );
    assert.equal(
      snapshot.transfers.some((transfer) => transfer.id === "receipt-135"),
      false,
    );
  });

  await t.test("global pending admission remains bounded across multiple peers", (context) => {
    const { other } = fixture(context);
    engine.watch(false);
    const others = Array.from({ length: 5 }, (_, i) => ({ ...peer("guest"), id: `different-peer-${i}` }));
    engine.setDirectory([other, ...others]);
    for (const [index, other] of others.entries()) {
      engine.receiveSignal(other.id, { kind: "offer", session: `different-session-${index}`, sdp: "local fixture" });
      const channel = LocalPeerConnection.created.at(-1)!.channel;
      channel.onopen?.();
      for (let i = 0; i < 8; i++) channel.control(offer(`global-${index}-${i}`));
    }
    t.mock.timers.tick(250);
    assert.equal(engine.nearbySnapshot().transfers.length, 32);
  });

  await t.test("held introductions have a global admission bound", (context) => {
    fixture(context, "guest", false);
    let rejected = 0;
    for (let i = 0; i < 33; i++) {
      engine.receiveSignal(`unknown-peer-${i}`, {
        kind: "offer",
        session: `unknown-session-${i}`,
        sdp: "local fixture",
      });
      const channel = LocalPeerConnection.created.at(-1)!.channel;
      channel.onopen?.();
      channel.control(offer(`unknown-${i}`));
      rejected += channel.sent.filter(
        (message) => typeof message === "string" && (JSON.parse(message) as { t: string }).t === "decline",
      ).length;
    }
    assert.equal(rejected, 1);
    t.mock.timers.tick(10_250);
    assert.equal(engine.nearbySnapshot().transfers.length, 32);
  });

  await t.test("disposable history is pruned while new ordinary sends remain usable", (context) => {
    const { other, channel } = fixture(context);
    const ids: string[] = [];
    for (let i = 0; i < 136; i++) {
      const id = engine.send(other, [], [], "test");
      ids.push(id);
      channel.control({ t: "done", id });
    }
    t.mock.timers.tick(250);
    const snapshot = engine.nearbySnapshot();
    assert.equal(snapshot.transfers.length, 128);
    assert.equal(
      snapshot.transfers.every((transfer) => transfer.state === "done"),
      true,
    );
    assert.equal(
      snapshot.transfers.some((transfer) => transfer.id === ids[0]),
      false,
    );
    assert.equal(snapshot.transfers[0].id, ids.at(-1));
  });

  await t.test("retained offer metadata has a global size bound", (context) => {
    const { channel } = fixture(context);
    const files = Array.from({ length: 3000 }, () => ({ path: "x".repeat(1024), size: 0, type: "", modified: 1 }));
    for (let i = 0; i < 6; i++) channel.control({ ...offer(`metadata-${i}`), files });
    t.mock.timers.tick(250);
    assert.equal(engine.nearbySnapshot().transfers.length, 5);
  });

  for (const stage of ["open", "write", "finish"] as const)
    await t.test(`cancellation during sink.${stage} discards late storage without revival`, async (context) => {
      // An isolated engine uses a controlled Sink adapter to hold one actual await boundary.
      // Transport framing, Link, Lanes, and all cancellation callbacks remain production code.
      const key = `relay-nearby-audit-sink-${stage}`;
      let resume: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => (resume = resolve));
      let entered = false;
      let active = true;
      let written = 0;
      let discards = 0;
      const wait = async (at: typeof stage) => {
        if (at === stage) {
          entered = true;
          await gate;
        }
      };
      const sink = {
        get written() {
          return written;
        },
        crc: 0,
        async write(bytes: Uint8Array) {
          await wait("write");
          written += bytes.length;
        },
        async finish() {
          await wait("finish");
          return new File(["test"], "test.txt");
        },
        discard() {
          active = false;
          written = 0;
          discards++;
          return Promise.resolve();
        },
      };
      Reflect.set(globalThis, Symbol.for(key), {
        open: async () => {
          await wait("open");
          return sink;
        },
      });
      context.after(() => Reflect.deleteProperty(globalThis, Symbol.for(key)));
      const source = `const fixture = Reflect.get(globalThis, Symbol.for(${JSON.stringify(key)}));
        export const roomFor = async () => true;
        export const openSink = () => fixture.open();`;
      const adapter = `data:text/javascript,${encodeURIComponent(source)}`;
      const sinkHook = registerHooks({
        resolve(specifier, resolution, nextResolve) {
          if (specifier === "./sink" && resolution.parentURL?.includes(`?sink=${stage}`))
            return nextResolve(adapter, resolution);
          return nextResolve(specifier, resolution);
        },
      });
      context.after(() => sinkHook.deregister());
      const isolated = (await import(`../client/lib/nearby/engine.ts?sink=${stage}`)) as typeof Engine;
      context.after(() => isolated.clearEngine());
      isolated.startEngine({ self: "isolated-self", signal: () => Promise.resolve() });
      const other = peer("guest");
      isolated.setDirectory([other]);
      isolated.receiveSignal(other.id, { kind: "offer", session: "sink-session", sdp: "local fixture" });
      const pc = LocalPeerConnection.created.at(-1)!;
      pc.channel.onopen?.();
      pc.channel.control(offer(`late-${stage}`));
      await isolated.accept(`late-${stage}`);
      await setImmediate();
      pc.channel.bytes(0, 0, new TextEncoder().encode("test"));
      await setImmediate();
      assert.equal(entered, true, `sink.${stage} was reached before cancellation`);
      isolated.setDirectory([]);
      resume!();
      await setImmediate();
      t.mock.timers.tick(250);
      assert.equal(pc.closed, true);
      assert.equal(active, false);
      assert.equal(written, 0);
      assert.ok(discards > 0);
      const transfer = isolated.nearbySnapshot().transfers[0];
      assert.equal(transfer.state, "cancelled");
      assert.equal(transfer.text, null);
      assert.equal(transfer.received, null);
    });

  for (const have of [{ 0: 5 }, { 99: 0 }, { text: 0 }])
    await t.test(`accept offsets must describe this transfer: ${JSON.stringify(have)}`, async (context) => {
      const { other, channel } = fixture(context);
      const id = engine.send(other, [{ file: new File(["abcd"], "small.txt"), path: "small.txt" }], [], "");
      channel.control({ t: "accept", id, have, stream: 0 });
      await setImmediate();
      t.mock.timers.tick(250);
      assert.equal(engine.nearbySnapshot().transfers[0].state, "failed");
      assert.equal(
        channel.sent.some((frame) => typeof frame !== "string"),
        false,
      );
    });

  await t.test("control validation rejects malformed discriminants, types, and numeric bounds", async () => {
    const { controlOf } = await import("../client/lib/nearby/protocol.ts");
    const validFile = { path: "file.txt", size: 4, type: "text/plain", modified: 1 };
    for (const message of [
      null,
      [],
      {},
      { t: "unrecognized", id: "test" },
      { ...offer(""), id: 4 },
      { ...offer("test"), id: "x".repeat(65) },
      { ...offer("test"), folders: [null] },
      { ...offer("test"), preview: [] },
      { ...offer("test"), text: -1 },
      { ...offer("test"), text: Infinity },
      { ...offer("test"), files: [{ ...validFile, size: 1.5 }] },
      { ...offer("test"), files: [{ ...validFile, modified: "yesterday" }] },
      { ...offer("test"), files: [{ ...validFile, type: [] }] },
      { ...offer("test"), files: [{ ...validFile, size: Number.MAX_SAFE_INTEGER }], text: 1 },
      { t: "accept", id: "test", have: [], stream: 0 },
      { t: "accept", id: "test", have: { 0: -1 }, stream: 0 },
      { t: "accept", id: "test", have: { 0: 1.5 }, stream: 0 },
      { t: "accept", id: "test", have: {}, stream: 2 ** 32 },
      { t: "accept", id: "test", have: {}, stream: Infinity },
      { t: "decline", id: "test", reason: "other" },
    ])
      assert.equal(controlOf(message), null, JSON.stringify(message));
    for (const message of [
      offer("test"),
      { t: "accept", id: "test", have: { 0: 4, text: 0 }, stream: 0 },
      { t: "decline", id: "test", reason: "declined" },
      { t: "cancel", id: "test" },
      { t: "done", id: "test" },
    ])
      assert.ok(controlOf(message));
  });
});
