// The browser's side of Nearby's candidate rule (shared/candidates.ts): every description from
// another device is cut down to its local candidates before the browser uses it, including the
// extra lanes', which travel over the connection itself and never pass through Relay. And a signal
// Relay refuses as busy is sent again rather than ending the connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type * as LinkModule from "../client/lib/nearby/link.ts";
import type * as LanesModule from "../client/lib/lanes.ts";
import type { NearbySignal } from "../shared/nearby.ts";

const LOCAL = "a=candidate:1 1 udp 2122260223 192.168.1.30 50001 typ host";
const PUBLIC = "a=candidate:2 1 udp 2122260223 198.51.100.77 40000 typ host";
const FOREIGN = ["v=0", LOCAL, PUBLIC, ""].join("\r\n");

class Peer {
  static made: Peer[] = [];
  remote: string[] = [];
  localDescription: { type: string; sdp: string } | null = null;
  signalingState = "stable";
  iceGatheringState = "complete";
  connectionState = "new";
  ondatachannel = null;
  onconnectionstatechange = null;
  constructor() {
    Peer.made.push(this);
  }
  createDataChannel() {
    return { onopen: null, onclose: null, close() {} };
  }
  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "v=0 mine" });
  }
  createAnswer() {
    return Promise.resolve({ type: "answer", sdp: "v=0 mine" });
  }
  setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
    this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
    return Promise.resolve();
  }
  setRemoteDescription(description: { sdp: string }) {
    this.remote.push(description.sdp);
    return Promise.resolve();
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const events = { open() {}, end() {}, control() {}, stream() {} };
const lines = (sdp: string | undefined) => (sdp ?? "").split("\r\n").filter((line) => line.startsWith("a=candidate"));

test("a browser uses only the local candidates in another device's offer or answer", async (t) => {
  // Client modules leave off the extension, as the bundler allows.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") && !/\.[a-z]+(?:[?#].*)?$/i.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: Peer });
  t.after(() => Reflect.deleteProperty(globalThis, "RTCPeerConnection"));
  const { Link }: typeof LinkModule = await import("../client/lib/nearby/link.ts");
  const { Lanes }: typeof LanesModule = await import("../client/lib/lanes.ts");

  // Answering a Nearby offer.
  const answering = Link.answer("peer-a", "session-one", FOREIGN, events, () => Promise.resolve());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(lines(Peer.made.at(-1)!.remote[0]), [LOCAL]);
  answering.close();

  // The answer to this side's offer.
  const offering = Link.offer("peer-b", events, () => Promise.resolve());
  await new Promise((resolve) => setTimeout(resolve, 10));
  await offering.answered(FOREIGN);
  assert.deepEqual(lines(Peer.made.at(-1)!.remote[0]), [LOCAL]);
  offering.close();

  // The extra lanes' answers, which arrive over the first lane.
  const lane = new Peer();
  const answered = (Lanes.prototype as unknown as { answered: (pcs: Peer[], sdps: string[]) => Promise<void> })
    .answered;
  await answered.call({ drop() {} }, [lane], [FOREIGN]);
  assert.deepEqual(lines(lane.remote[0]), [LOCAL]);
});

test("a signal Relay refuses as busy is sent again, and the connection carries on", async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") && !/\.[a-z]+(?:[?#].*)?$/i.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: Peer });
  t.after(() => Reflect.deleteProperty(globalThis, "RTCPeerConnection"));
  const { Link }: typeof LinkModule = await import("../client/lib/nearby/link.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const sent: NearbySignal[] = [];
  const refusals = [503, 429];
  let ended = "";
  const link = Link.offer("peer-c", { ...events, end: (_link, why) => (ended = why) }, (signal) => {
    sent.push(signal);
    const status = refusals.shift();
    return status ? Promise.reject(Object.assign(new Error("busy"), { status })) : Promise.resolve();
  });
  await settle();
  assert.equal(sent.length, 1);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(sent.length, 2, "sent again after a busy device");
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(sent.length, 3, "and again after too many");
  assert.equal(link.state, "connecting");
  assert.equal(ended, "");

  // Any other refusal ends it, as before.
  const gone = Link.offer("peer-d", { ...events, end: (_link, why) => (ended = why) }, () =>
    Promise.reject(Object.assign(new Error("gone"), { status: 404 })),
  );
  await settle();
  assert.equal(gone.state, "ended");
  assert.equal(ended, "unreachable");
  link.close();
});
