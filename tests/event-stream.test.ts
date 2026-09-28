import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { eventStream } from "../client/lib/event-stream.ts";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
});
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

class Source extends EventTarget {
  static instances: Source[] = [];
  readonly url: string;
  readyState = 0;
  closed = false;
  constructor(url: string) {
    super();
    this.url = url;
    Source.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  event(name: string, data: unknown = {}) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}

for (const url of ["/api/events?tab=same-tab", "/api/r/guest/events?tab=same-tab"]) {
  test(`${url}: CONNECTING errors and short ready-close loops have one exponential retry clock`, (t) => {
    Source.instances = [];
    const original = globalThis.EventSource;
    globalThis.EventSource = Source as unknown as typeof EventSource;
    t.after(() => {
      globalThis.EventSource = original;
    });
    t.mock.method(Math, "random", () => 0);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let failures = 0;
    const stream = eventStream(url, { failed: () => failures++ });
    const first = Source.instances[0];
    first.event("ready", { beatMs: 20_000 });
    first.event("error"); // CONNECTING, not CLOSED: native automatic retries must still be stopped.
    first.event("error"); // A stale queued event must not schedule another retry.
    assert.equal(first.closed, true);
    assert.equal(failures, 1);
    t.mock.timers.tick(999);
    assert.equal(Source.instances.length, 1);
    t.mock.timers.tick(1);
    const second = Source.instances[1];
    second.event("ready");
    second.event("error");
    t.mock.timers.tick(1999);
    assert.equal(Source.instances.length, 2);
    t.mock.timers.tick(1);
    const third = Source.instances[2];
    assert.equal(third.url, first.url);
    third.event("beat");
    third.event("error");
    t.mock.timers.tick(1000);
    assert.equal(Source.instances.length, 4, "a sustained stream resets the backoff");
    Source.instances[3].event("error");
    stream.close();
    t.mock.timers.tick(100_000);
    assert.equal(Source.instances.length, 4, "cleanup cancels every retry and silence timer");
  });
}

test("limited streams release sockets, refresh views, respect capacity delays and stop after revocation", (t) => {
  Source.instances = [];
  const original = globalThis.EventSource;
  globalThis.EventSource = Source as unknown as typeof EventSource;
  t.after(() => {
    globalThis.EventSource = original;
  });
  t.mock.method(Math, "random", () => 0);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let refreshes = 0;
  let failures = 0;
  let ended = 0;
  const stream = eventStream("/events", {
    limited: () => refreshes++,
    failed: () => failures++,
    ended: () => ended++,
  });
  Source.instances[0].event("limited", { retryMs: 20_000 });
  assert.equal(Source.instances[0].closed, true);
  assert.equal(refreshes, 1);
  assert.equal(failures, 0);
  stream.retryNow();
  t.mock.timers.tick(19_999);
  assert.equal(Source.instances.length, 1);
  t.mock.timers.tick(1);
  Source.instances[1].event("ended", { reason: "expired" });
  assert.equal(ended, 1);
  assert.equal(Source.instances[1].closed, true);
  stream.retryNow();
  t.mock.timers.tick(100_000);
  assert.equal(Source.instances.length, 2);
});

test("silent streams reconnect and network retries remain bounded", (t) => {
  Source.instances = [];
  const original = globalThis.EventSource;
  globalThis.EventSource = Source as unknown as typeof EventSource;
  t.after(() => {
    globalThis.EventSource = original;
  });
  t.mock.method(Math, "random", () => 0);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stream = eventStream("/events");
  Source.instances[0].event("ready", { beatMs: 200 });
  t.mock.timers.tick(500);
  assert.equal(Source.instances[0].closed, true);
  stream.retryNow();
  assert.equal(Source.instances.length, 2);
  for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
    Source.instances.at(-1)!.event("error");
    const count: number = Source.instances.length;
    t.mock.timers.tick(delay - 1);
    assert.equal(Source.instances.length, count);
    t.mock.timers.tick(1);
    assert.equal(Source.instances.length, count + 1);
  }
  stream.close();
});

test("concurrent first tabs converge on the stored browser ID even when storage events arrive out of order", (t) => {
  Source.instances = [];
  const original = globalThis.EventSource;
  globalThis.EventSource = Source as unknown as typeof EventSource;
  const events = new EventTarget();
  const descriptors = ["addEventListener", "removeEventListener"].map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true,
    value: events.addEventListener.bind(events),
  });
  Object.defineProperty(globalThis, "removeEventListener", {
    configurable: true,
    value: events.removeEventListener.bind(events),
  });
  t.after(() => {
    globalThis.EventSource = original;
    for (const [index, name] of ["addEventListener", "removeEventListener"].entries()) {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  t.mock.method(Math, "random", () => 0);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = eventStream("/api/events?tab=first");
  const losing = Source.instances[0];
  const winningId = "a".repeat(32);
  localStorage.setItem("relay.stream-browser", winningId);
  const second = eventStream("/api/r/guest/events?tab=second");
  const winning = Source.instances[1];
  events.dispatchEvent(Object.assign(new Event("storage"), { key: "relay.stream-browser", newValue: "b".repeat(32) }));
  assert.equal(losing.closed, true, "the stale group releases its socket before retrying");
  assert.equal(winning.closed, false);
  t.mock.timers.tick(1000);
  assert.match(Source.instances[2].url, new RegExp(`browser=${winningId}$`));
  events.dispatchEvent(Object.assign(new Event("storage"), { key: "relay.stream-browser", newValue: "c".repeat(32) }));
  assert.equal(Source.instances[2].closed, false, "a stale event cannot replace the stored winner");
  first.close();
  second.close();
  localStorage.setItem("relay.stream-browser", "d".repeat(32));
  events.dispatchEvent(Object.assign(new Event("storage"), { key: "relay.stream-browser" }));
  t.mock.timers.tick(1000);
  assert.equal(Source.instances.length, 3, "cleanup removes storage listeners too");
});

test("unavailable storage uses bounded lease probes without inventing a separate browser identity", (t) => {
  Source.instances = [];
  const original = globalThis.EventSource;
  globalThis.EventSource = Source as unknown as typeof EventSource;
  t.after(() => {
    globalThis.EventSource = original;
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("Storage disabled");
    },
  });
  t.mock.method(Math, "random", () => 0);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let refreshes = 0;
  const stream = eventStream("/api/events?tab=same", { limited: () => refreshes++ });
  assert.equal(Source.instances[0].url, "/api/events?tab=same");
  Source.instances[0].event("limited", { retryMs: 20_000 });
  assert.equal(Source.instances[0].closed, true);
  assert.equal(refreshes, 1);
  stream.retryNow();
  t.mock.timers.tick(19_999);
  assert.equal(Source.instances.length, 1);
  t.mock.timers.tick(1);
  assert.equal(Source.instances[1].url, Source.instances[0].url);
  stream.close();
});

test("ready passes on where changes stood, and nothing when the server didn't say", (t) => {
  Source.instances = [];
  const original = globalThis.EventSource;
  globalThis.EventSource = Source as unknown as typeof EventSource;
  t.after(() => {
    globalThis.EventSource = original;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const opened: unknown[] = [];
  const stream = eventStream("/api/events?tab=same", { ready: (changes) => opened.push(changes) });
  Source.instances[0].event("ready", { beatMs: 20_000, changes: "boot.7" });
  Source.instances[0].event("ready", { beatMs: 20_000 });
  Source.instances[0].dispatchEvent(new MessageEvent("ready", { data: "not json" }));
  assert.deepEqual(opened, ["boot.7", undefined, undefined]);
  stream.close();
});
