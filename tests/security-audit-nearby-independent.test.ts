// Independent review fixtures: only disposable browser transport/storage adapters are replaced.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import type { NearbyPeer } from "../shared/nearby.ts";

const evidence: { case: string; observed: unknown }[] = [];
after(async () => {
  await mkdir("work/security-audit", { recursive: true });
  await writeFile("work/security-audit/nearby-independent-runtime.json", JSON.stringify(evidence, null, 2) + "\n");
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};
type Boundary = "open" | "write" | "finish" | "estimate";
let hold: { boundary: Boundary; reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null =
  null;
const pause = async (boundary: Boundary) => {
  if (hold?.boundary !== boundary) return;
  const gate = hold;
  hold = null;
  gate.reached.resolve();
  await gate.release.promise;
};
const gateFor = (boundary: Boundary) => {
  assert.equal(hold, null);
  const gate = { boundary, reached: deferred(), release: deferred() };
  hold = gate;
  return gate;
};

const diskFiles = new Map<string, LocalFileHandle>();
class LocalFileHandle {
  readonly name: string;
  bytes: Uint8Array[] = [];
  constructor(name: string) {
    this.name = name;
  }
  async createWritable() {
    await pause("open");
    let aborted = false;
    return {
      write: async (bytes: Uint8Array) => {
        await pause("write");
        if (aborted) throw new Error("The disposable writable was aborted");
        this.bytes.push(bytes.slice());
      },
      close: async () => {
        await pause("finish");
      },
      abort: () => {
        aborted = true;
        this.bytes = [];
        return Promise.resolve();
      },
    };
  }
  getFile() {
    return Promise.resolve(new File(this.bytes as Uint8Array<ArrayBuffer>[], this.name));
  }
}
const diskDirectory = {
  getDirectoryHandle: () => Promise.resolve(diskDirectory),
  getFileHandle: (name: string) => {
    const file = new LocalFileHandle(name);
    diskFiles.set(name, file);
    return Promise.resolve(file);
  },
  removeEntry: (name: string) => {
    diskFiles.delete(name);
    return Promise.resolve();
  },
  async *keys() {},
};
let enoughRoom = true;

class Channel {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onbufferedamountlow = null;
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  closed = false;
  send(value: string | Uint8Array) {
    if (!this.closed) this.sent.push(value);
  }
  close() {
    this.closed = true;
  }
  control(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  bytes(stream: number, offset: number, text: string) {
    const bytes = new TextEncoder().encode(text);
    const frame = new Uint8Array(12 + bytes.length);
    new DataView(frame.buffer).setUint32(0, stream);
    new DataView(frame.buffer).setFloat64(4, offset);
    frame.set(bytes, 12);
    this.onmessage?.({ data: frame.buffer });
  }
}
class PeerConnection {
  static created: PeerConnection[] = [];
  channel = new Channel();
  signalingState = "stable";
  iceGatheringState = "complete";
  localDescription: { sdp: string } | null = null;
  ondatachannel = null;
  onconnectionstatechange = null;
  closed = false;
  constructor() {
    PeerConnection.created.push(this);
  }
  createDataChannel() {
    return this.channel;
  }
  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "disposable" });
  }
  createAnswer() {
    return Promise.resolve({ type: "answer", sdp: "disposable" });
  }
  setLocalDescription(value: { type: string; sdp: string }) {
    this.localDescription = value;
    this.signalingState = value.type === "offer" ? "have-local-offer" : "stable";
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
const peer: NearbyPeer = {
  id: "independent-peer",
  name: "Disposable peer",
  kind: "guest",
  deviceKind: "computer",
  owner: null,
  present: true,
};
const offer = (id: string, file = false) => ({
  t: "offer",
  id,
  files: file ? [{ path: "four.txt", size: 4, type: "text/plain", modified: 1 }] : [],
  folders: [],
  text: file ? 0 : 4,
  preview: "test",
});

test("Nearby independent cancellation, introduction and resume verification", async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(
        specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier,
        context,
      );
    },
  });
  t.after(() => hooks.deregister());
  for (const [key, value] of Object.entries({
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false }),
    navigator: {
      storage: {
        getDirectory: () => Promise.resolve(diskDirectory),
        estimate: async () => {
          await pause("estimate");
          return { quota: enoughRoom ? 1000 : 0, usage: 0 };
        },
      },
      locks: {
        request: (_name: string, run: () => unknown) => Promise.resolve(run()),
        query: () => Promise.resolve({ held: [] }),
      },
    },
    FileSystemFileHandle: LocalFileHandle,
    RTCPeerConnection: PeerConnection,
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() =>
      original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key),
    );
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engine = await import("../client/lib/nearby/engine.ts");
  t.after(() => engine.clearEngine());
  const fixture = (listed = true, opened = true) => {
    engine.clearEngine();
    engine.watch(false);
    engine.setDirectory([]);
    enoughRoom = true;
    engine.startEngine({ self: "independent-self", signal: async () => {} });
    engine.setDirectory(listed ? [peer] : []);
    engine.receiveSignal(peer.id, {
      kind: "offer",
      session: `session-${PeerConnection.created.length}`,
      sdp: "disposable",
    });
    const pc = PeerConnection.created.at(-1)!;
    if (opened) pc.channel.onopen?.();
    engine.watch(true);
    return { pc, channel: pc.channel };
  };
  const flush = async () => {
    await setImmediate();
    t.mock.timers.tick(250);
  };
  const transfer = (id: string) => engine.nearbySnapshot().transfers.find((value) => value.id === id);

  await t.test("an insufficient-space answer arriving after removal cannot overwrite cancellation", async () => {
    const { channel } = fixture();
    channel.control(offer("late-space"));
    enoughRoom = false;
    const gate = gateFor("estimate");
    const accepted = engine.accept("late-space");
    await gate.reached.promise;
    engine.setDirectory([]);
    gate.release.resolve();
    await accepted;
    await flush();
    evidence.push({ case: "late insufficient-space after peer removal", observed: transfer("late-space")?.state });
    assert.equal(transfer("late-space")?.state, "cancelled");
  });

  for (const boundary of ["open", "write", "finish"] as const)
    await t.test(`disk sink ${boundary} completion cannot revive a removed peer's receive`, async () => {
      const { channel } = fixture();
      const id = `late-sink-${boundary}`;
      const notices: string[] = [];
      const unsubscribe = engine.onNotice((value) => notices.push(value.kind));
      channel.control(offer(id, true));
      await engine.accept(id);
      await setImmediate();
      const gate = gateFor(boundary);
      channel.bytes(0, 0, "test");
      await gate.reached.promise;
      engine.setDirectory([]);
      gate.release.resolve();
      await flush();
      unsubscribe();
      const state = transfer(id);
      evidence.push({
        case: `late disk sink ${boundary}`,
        observed: { state: state?.state, received: state?.received, filesRetained: diskFiles.size },
      });
      assert.equal(state?.state, "cancelled");
      assert.equal(state?.received, null);
      assert.equal(notices.includes("received"), false);
      assert.equal(diskFiles.size, 0);
    });

  await t.test("removing a peer stops an established send and rejects its late completion", async () => {
    const { pc, channel } = fixture();
    const id = engine.send(peer, [{ file: new File(["abcd"], "four.txt"), path: "four.txt" }], [], "");
    channel.control({ t: "accept", id, have: {}, stream: 0 });
    await flush();
    assert.equal(transfer(id)?.state, "running");
    assert.equal(channel.sent.filter((value) => typeof value !== "string").length, 1);
    engine.setDirectory([]);
    channel.control({ s: 0, credit: 4 });
    channel.control({ t: "done", id });
    engine.setDirectory([peer]);
    engine.receiveSignal(peer.id, { kind: "offer", session: "late-outgoing-completion", sdp: "disposable" });
    const next = PeerConnection.created.at(-1)!.channel;
    next.onopen?.();
    next.control({ t: "done", id });
    await flush();
    evidence.push({
      case: "established outgoing removal and late done",
      observed: { closed: pc.closed, state: transfer(id)?.state, moved: transfer(id)?.moved },
    });
    assert.equal(pc.closed, true);
    assert.equal(transfer(id)?.state, "cancelled");
    assert.equal(transfer(id)?.moved, 0);
  });

  await t.test("removing a peer cancels a send whose connection has not opened", async () => {
    const { pc } = fixture(true, false);
    const id = engine.send(peer, [], [], "pending");
    engine.setDirectory([]);
    const created = PeerConnection.created.length;
    pc.channel.onopen?.();
    t.mock.timers.tick(10_000);
    await flush();
    evidence.push({
      case: "pending outgoing removal",
      observed: { state: transfer(id)?.state, reconnects: PeerConnection.created.length - created },
    });
    assert.equal(transfer(id)?.state, "cancelled");
    assert.equal(PeerConnection.created.length, created);
    assert.equal(pc.closed, true);
  });

  await t.test("a removed peer can be relisted for a new transfer without reviving the old one", async () => {
    const { channel: old } = fixture();
    old.control(offer("old-introduction"));
    engine.setDirectory([]);
    engine.setDirectory([peer]);
    engine.receiveSignal(peer.id, { kind: "offer", session: "relisted-session", sdp: "disposable" });
    const channel = PeerConnection.created.at(-1)!.channel;
    channel.onopen?.();
    channel.control(offer("new-introduction"));
    await flush();
    evidence.push({
      case: "relisted peer",
      observed: { old: transfer("old-introduction")?.state, next: transfer("new-introduction")?.state },
    });
    assert.equal(transfer("old-introduction")?.state, "cancelled");
    assert.equal(transfer("new-introduction")?.state, "incoming");
  });

  await t.test("an unknown introduction still waits for the directory and can finish normally", async () => {
    const { channel } = fixture(false);
    channel.control(offer("unknown-introduction"));
    await flush();
    assert.equal(transfer("unknown-introduction"), undefined);
    engine.setDirectory([peer]);
    await engine.accept("unknown-introduction");
    await setImmediate();
    channel.bytes(0, 0, "test");
    await flush();
    evidence.push({ case: "unknown initial introduction", observed: transfer("unknown-introduction")?.state });
    assert.equal(transfer("unknown-introduction")?.state, "done");
    assert.equal(transfer("unknown-introduction")?.text, "test");
  });

  for (const have of [{ 0: 4, text: 2 }, { 0: 0, text: 0 }, { 0: 5 }, { text: 3 }, { 1: 0 }])
    await t.test(`resume offsets apply to real file and text payloads ${JSON.stringify(have)}`, async () => {
      const { channel } = fixture();
      const id = engine.send(peer, [{ file: new File(["abcd"], "four.txt"), path: "four.txt" }], [], "ef");
      channel.control({ t: "accept", id, have, stream: 7 });
      await flush();
      const valid = (have[0] ?? 0) <= 4 && (have.text ?? 0) <= 2 && !(1 in have);
      const frames = channel.sent.filter((value): value is Uint8Array => typeof value !== "string");
      evidence.push({
        case: `payload resume ${JSON.stringify(have)}`,
        observed: { state: transfer(id)?.state, binaryFrames: frames.length },
      });
      assert.equal(transfer(id)?.state, valid ? "running" : "failed");
      if (!valid) assert.equal(frames.length, 0);
      for (const frame of frames) {
        const view = new DataView(frame.buffer);
        const max = view.getUint32(0) === 7 ? 4 : 2;
        assert.ok(view.getFloat64(4) + frame.length - 12 <= max);
      }
    });

  await t.test("malformed controls close the established connection without escaping callbacks", async () => {
    for (const malformed of [
      null,
      [],
      { t: "offer", id: "bad", files: [null] },
      { t: "accept", id: "bad", have: { 0: -1 }, stream: 0 },
      { t: "offer", id: "bad", files: [], folders: [42], text: 4, preview: "test" },
    ]) {
      const { pc, channel } = fixture();
      assert.doesNotThrow(() => channel.control(malformed));
      await flush();
      assert.equal(pc.closed, true);
    }
    evidence.push({ case: "malformed controls", observed: "all rejected; link closed; no callback exception" });
  });
});
