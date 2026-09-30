// Bounded resource tests: only local transport setup is synthetic. Link, Lanes, Mux,
// engine and sink are production modules; a 64-byte policy avoids large allocations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setMaxListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
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

test("Nearby aggregates receive admission across the tab", async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") && !/\.[a-z]+(?:[?#].*)?$/i.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (/\/nearby\/(sink|budget)\.ts(?:\?.*)?$/.test(url))
        return {
          ...loaded,
          source: (typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source)).replace(
            "2 * 1024 ** 3",
            "64",
          ),
        };
      return loaded;
    },
  });
  t.after(() => hooks.deregister());
  for (const [key, value] of Object.entries({
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false }),
    navigator: {},
    RTCPeerConnection: LocalPeerConnection,
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() =>
      original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key),
    );
  }
  // Isolated module graphs represent separate tabs, but share this fixture EventTarget.
  setMaxListeners(16, document);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engine: typeof Engine = await import("../client/lib/nearby/engine.ts");
  t.after(() => engine.clearEngine());
  const connect = (instance: typeof Engine, session = "local") => {
    instance.startEngine({ self: "receiver", signal: () => Promise.resolve() });
    instance.setDirectory([
      { id: "sender", name: "Sender", kind: "guest", owner: null, deviceKind: "computer", present: true },
    ]);
    instance.receiveSignal("sender", { kind: "offer", session, sdp: "local fixture" });
    const channel = LocalPeerConnection.created.at(-1)!.channel;
    channel.onopen?.();
    instance.watch(true);
    return channel;
  };
  const controls = (instance: typeof Engine, channel: LocalChannel) => {
    const offer = (id: string, size: number, text = 0) => {
      channel.control({
        t: "offer",
        id,
        files: size ? [{ path: "bytes.bin", size, type: "", modified: 1 }] : [],
        folders: [],
        text,
        preview: "",
      });
    };
    const transfer = (id: string) => {
      t.mock.timers.tick(250);
      return instance.nearbySnapshot().transfers.find((transfer) => transfer.id === id)!;
    };
    const deliver = async (id: string, bytes: Uint8Array, offset = 0) => {
      await setImmediate();
      const accepts = channel.sent
        .filter((message): message is string => typeof message === "string")
        .map((message) => JSON.parse(message) as { t: string; id: string; stream: number });
      const accepted = accepts.findLast((message) => message.t === "accept" && message.id === id)!;
      channel.bytes(accepted.stream, offset, bytes);
      await setImmediate();
    };
    return { channel, offer, transfer, deliver };
  };

  const fixture = async () => {
    engine.clearEngine();
    engine.watch(false);
    await setImmediate();
    t.mock.timers.tick(250);
    return controls(engine, connect(engine));
  };

  await t.test("concurrent accepts reserve atomically; duplicate accept cannot double-charge", async () => {
    const { offer, transfer } = await fixture();
    offer("a", 40);
    offer("b", 40);
    await Promise.all([engine.accept("a"), engine.accept("a"), engine.accept("b")]);
    assert.equal(transfer("a").state, "running");
    assert.equal(transfer("b").state, "failed");
    offer("remainder", 24);
    await engine.accept("remainder");
    assert.equal(transfer("remainder").state, "running");
  });

  await t.test("completed file and text receipts hold capacity until dismissal", async () => {
    const { offer, transfer, deliver } = await fixture();
    offer("receipt", 40);
    await engine.accept("receipt");
    const bytes = Uint8Array.from({ length: 40 }, (_, i) => i);
    await deliver("receipt", bytes);
    assert.equal(transfer("receipt").state, "done");
    assert.deepEqual(new Uint8Array(await transfer("receipt").received![0].arrayBuffer()), bytes);
    // Reading/saving the receipt does not relinquish the engine's ownership.
    offer("blocked", 25);
    await engine.accept("blocked");
    assert.equal(transfer("blocked").state, "failed");
    engine.dismiss("receipt");
    await setImmediate();
    offer("text", 0, 64);
    await engine.accept("text");
    await deliver("text", new TextEncoder().encode("x".repeat(64)));
    assert.equal(transfer("text").text, "x".repeat(64));
    offer("text-blocked", 1);
    await engine.accept("text-blocked");
    assert.equal(transfer("text-blocked").state, "failed");
    engine.dismiss("text");
    engine.dismiss("text");
    await setImmediate();
    offer("after", 64);
    await engine.accept("after");
    assert.equal(transfer("after").state, "running");
  });

  await t.test("stopping Nearby preserves completed receipt accounting", async () => {
    const first = await fixture();
    first.offer("retained", 40);
    await engine.accept("retained");
    await first.deliver("retained", new Uint8Array(40));
    engine.stopEngine("test stop");
    const next = controls(engine, connect(engine, "restart"));
    assert.equal(next.transfer("retained").state, "done");
    next.offer("blocked", 25);
    await engine.accept("blocked");
    assert.equal(next.transfer("blocked").state, "failed");
    engine.dismiss("retained");
    await setImmediate();
    next.offer("after", 64);
    await engine.accept("after");
    assert.equal(next.transfer("after").state, "running");
  });

  await t.test("cancel, remote cancel, decline and clear release exactly once", async () => {
    const { channel, offer, transfer } = await fixture();
    for (const id of ["local", "remote"]) {
      offer(id, 64);
      await engine.accept(id);
      if (id === "local") {
        engine.cancel(id);
        engine.cancel(id);
        engine.dismiss(id);
      } else channel.control({ t: "cancel", id });
      await setImmediate();
    }
    offer("declined", 64);
    engine.decline("declined");
    offer("after", 64);
    await engine.accept("after");
    assert.equal(transfer("after").state, "running");
    offer("extra", 1);
    await engine.accept("extra");
    assert.equal(transfer("extra").state, "failed");
    engine.clearEngine();
    const next = await fixture();
    next.offer("cleared", 64);
    await engine.accept("cleared");
    assert.equal(next.transfer("cleared").state, "running");
  });

  await t.test("a mismatched stream releases its reservation after failure", async () => {
    const { offer, transfer, deliver } = await fixture();
    offer("bad", 40);
    await engine.accept("bad");
    await deliver("bad", new Uint8Array(41));
    assert.equal(transfer("bad").state, "failed");
    offer("after", 64);
    await engine.accept("after");
    assert.equal(transfer("after").state, "running");
  });

  await t.test("one shared budget covers different peers and resumed offers", async () => {
    const { channel, offer, transfer } = await fixture();
    offer("resumed", 40);
    await engine.accept("resumed");
    offer("resumed", 40);
    await setImmediate();
    offer("remaining", 24);
    await engine.accept("remaining");
    assert.equal(transfer("remaining").state, "running");
    engine.setDirectory(
      ["sender", "other"].map((id) => ({
        id,
        name: id,
        kind: "guest" as const,
        owner: null,
        deviceKind: "computer" as const,
        present: true,
      })),
    );
    engine.receiveSignal("other", { kind: "offer", session: "other", sdp: "local fixture" });
    const other = LocalPeerConnection.created.at(-1)!.channel;
    other.onopen?.();
    other.control({ t: "offer", id: "other-offer", files: [], folders: [], text: 1, preview: "" });
    await engine.accept("other-offer");
    assert.equal(transfer("other-offer").state, "failed");
    assert.ok(channel.sent.length);
  });

  await t.test(
    "disk creation failure re-admits fallback; disk-backed files do not consume memory budget",
    async (context) => {
      await fixture();
      let failOpen = false;
      let writes = 0;
      let stored = new Uint8Array();
      // Controlled storage failure adapter, not a claim of native disk or physical RAM evidence.
      const dir = {
        getDirectoryHandle: () => Promise.resolve(dir),
        keys: async function* () {},
        removeEntry: () => Promise.resolve(),
        getFileHandle: () =>
          Promise.resolve({
            createWritable() {
              if (failOpen) return Promise.reject(new DOMException("Synthetic storage failure", "UnknownError"));
              return Promise.resolve({
                write(bytes: Uint8Array) {
                  writes++;
                  stored = new Uint8Array(bytes);
                  return Promise.resolve();
                },
                close: () => Promise.resolve(),
                abort: () => Promise.resolve(),
              });
            },
            getFile: () => Promise.resolve(new File([stored], "disk.bin")),
          }),
      };
      const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
          storage: {
            getDirectory: () => Promise.resolve(dir),
            estimate: () => Promise.resolve({ quota: 1024, usage: 0 }),
          },
          locks: {
            request: (_name: string, callback: () => Promise<void>) => {
              void callback();
            },
            query: () => Promise.resolve({ held: [] }),
          },
        },
      });
      class FileHandle {
        createWritable() {}
      }
      Object.defineProperty(globalThis, "FileSystemFileHandle", { configurable: true, value: FileHandle });
      context.after(() => {
        Object.defineProperty(globalThis, "navigator", originalNavigator);
        Reflect.deleteProperty(globalThis, "FileSystemFileHandle");
      });
      const diskHook = registerHooks({
        resolve(specifier, resolution, nextResolve) {
          if (specifier === "./sink" && resolution.parentURL?.includes("?budget=disk"))
            return nextResolve("./sink.ts?disk", resolution);
          return nextResolve(specifier, resolution);
        },
      });
      context.after(() => diskHook.deregister());
      const isolated = (await import(`../client/lib/nearby/engine.ts?budget=${"disk"}`)) as typeof Engine;
      context.after(() => isolated.clearEngine());
      const { offer: sendOffer, transfer, deliver } = controls(isolated, connect(isolated, "disk"));
      sendOffer("disk-receipt", 80);
      await isolated.accept("disk-receipt");
      await deliver("disk-receipt", new Uint8Array(80).fill(7));
      assert.equal(transfer("disk-receipt").state, "done");
      assert.equal(transfer("disk-receipt").received![0].size, 80);
      assert.equal(writes, 1);
      sendOffer("text-claim", 0, 40);
      await isolated.accept("text-claim");
      sendOffer("late-fallback", 40);
      await isolated.accept("late-fallback");
      failOpen = true;
      await deliver("late-fallback", new Uint8Array(40).fill(7));
      assert.equal(transfer("late-fallback").state, "failed");
      assert.match(transfer("late-fallback").reason, /room/);
      assert.equal(transfer("late-fallback").moved, 0);
      assert.equal(writes, 1, "denied fallback never writes the payload");
      isolated.cancel("text-claim");
      await setImmediate();
      sendOffer("fallback-receipt", 40);
      await isolated.accept("fallback-receipt");
      await deliver("fallback-receipt", new Uint8Array(40).fill(7));
      assert.equal(transfer("fallback-receipt").state, "done");
      assert.deepEqual(
        new Uint8Array(await transfer("fallback-receipt").received![0].arrayBuffer()),
        new Uint8Array(40).fill(7),
      );
      sendOffer("next", 25);
      await isolated.accept("next");
      await deliver("next", new Uint8Array(25).fill(7));
      assert.equal(transfer("next").state, "failed");
      isolated.dismiss("fallback-receipt");
      await setImmediate();
      sendOffer("released", 64);
      await isolated.accept("released");
      await deliver("released", new Uint8Array(64).fill(7));
      assert.equal(transfer("released").state, "done");
    },
  );

  for (const stage of ["open", "write", "finish", "discard"] as const)
    await t.test(`cancel during ${stage} keeps capacity until the pending operation settles`, async (context) => {
      await fixture();
      let resume: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => (resume = resolve));
      let entered = false;
      // An adapter holds one storage await; actual admission and transfer framing remain intact.
      const sink = {
        written: 0,
        crc: 0,
        async write(bytes: Uint8Array) {
          if (stage === "write") {
            entered = true;
            await gate;
          }
          this.written += bytes.length;
        },
        async finish() {
          if (stage === "finish") {
            entered = true;
            await gate;
          }
          return new File([new Uint8Array(40)], "bytes.bin");
        },
        async discard() {
          if (stage === "discard") {
            entered = true;
            await gate;
          }
        },
        async open() {
          if (stage === "open") {
            entered = true;
            await gate;
          }
          return this;
        },
      };
      const key = `receive-budget-${stage}`;
      Reflect.set(globalThis, Symbol.for(key), sink);
      context.after(() => Reflect.deleteProperty(globalThis, Symbol.for(key)));
      const adapter = `data:text/javascript,${encodeURIComponent(`
        const sink = Reflect.get(globalThis, Symbol.for(${JSON.stringify(key)}));
        export const roomFor = async (_bytes, memory) => memory();
        export const openSink = async (_small, memory) => { if (!memory()) throw Error("full"); return sink.open(); };`)} `;
      const replacement = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "./sink" && context.parentURL?.includes(`?budget=${stage}`))
            return nextResolve(adapter.trim(), context);
          return nextResolve(specifier, context);
        },
      });
      context.after(() => replacement.deregister());
      // Isolate this engine's ledger while retaining production budget, Link, Lanes and Mux.
      const isolated = (await import(`../client/lib/nearby/engine.ts?budget=${stage}`)) as typeof Engine;
      context.after(() => isolated.clearEngine());
      const { channel: held, offer: sendOffer, transfer } = controls(isolated, connect(isolated, stage));
      sendOffer("held", 40);
      await isolated.accept("held");
      await setImmediate();
      held.bytes(0, 0, new Uint8Array(stage === "discard" ? 20 : 40));
      await setImmediate();
      if (stage !== "discard") assert.equal(entered, true);
      isolated.cancel("held");
      isolated.dismiss("held");
      assert.equal(entered, true);
      sendOffer("too-soon", 25);
      await isolated.accept("too-soon");
      assert.equal(transfer("too-soon").state, "failed");
      resume!();
      await setImmediate();
      sendOffer("after", 64);
      await isolated.accept("after");
      assert.equal(transfer("after").state, "running");
    });
});

test("receive reservations extend atomically and release idempotently", async () => {
  const { ReceiveBudget } = await import("../client/lib/nearby/budget.ts");
  const budget = new ReceiveBudget(64);
  const a = budget.reserve({ text: 8 })!;
  assert.equal(a.hold({ first: 40, second: 24 }), false);
  const b = budget.reserve({ file: 56 })!;
  assert.ok(b);
  assert.equal(a.hold({ text: 8 }), true);
  assert.equal(a.hold({ text: 9 }), false);
  b.release();
  b.release();
  assert.equal(a.hold({ first: 40, second: 16 }), true);
  assert.equal(b.hold({ file: 1 }), false);
  a.release();
  a.release();
  assert.equal(budget.reserve({ tooLarge: 65 }), null);
  assert.equal(budget.reserve({ bad: NaN }), null);
  assert.equal(budget.reserve({ one: Number.MAX_SAFE_INTEGER, two: 1 }), null);
  assert.ok(budget.reserve({ exact: 64 }));
});
