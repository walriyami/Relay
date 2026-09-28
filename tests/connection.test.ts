import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

test("a recovery response wins over stale failures without suppressing future outage diagnosis", async (t) => {
  const window = new EventTarget();
  const navigator = { onLine: true };
  for (const [key, value] of Object.entries({
    window,
    navigator,
    document: new EventTarget(),
    location: { origin: "http://relay.test" },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const probes: ((response: Response) => void)[] = [];
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => probes.push(resolve)));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const { connection, reportFailure, reportReachable } = await import("../client/lib/connection.ts");

  navigator.onLine = false;
  window.dispatchEvent(new Event("offline"));
  assert.equal(connection().state, "offline");
  reportReachable(); // A buffered API/stream response is older than the browser's offline signal.
  reportFailure();
  assert.equal(connection().state, "offline");
  assert.equal(connection().recovered, null);
  assert.equal(probes.length, 0, "offline browsers must not probe or claim recovery");
  navigator.onLine = true;
  window.dispatchEvent(new Event("online"));
  assert.equal(probes.length, 1);
  assert.equal(connection().probing, true);

  // A real API response recovers before the health probe or older failed requests finish.
  reportReachable();
  reportFailure();
  assert.equal(connection().state, "ok");
  assert.equal(connection().recovered, "offline");
  assert.equal(probes.length, 1, "an old request failure must not start a redundant probe");
  probes[0](Response.json({ ok: false }, { status: 503 }));
  await setImmediate();
  assert.equal(connection().state, "ok", "the superseded failed health probe must be ignored");
  assert.equal(connection().recovered, "offline");
  assert.equal(connection().probing, false);
  assert.equal(connection().retryAt, null);

  t.mock.timers.tick(2999);
  assert.equal(connection().recovered, "offline");
  t.mock.timers.tick(1);
  assert.equal(connection().recovered, null, "recovery feedback expires after three seconds");
  t.mock.timers.tick(1000);
  reportReachable(); // Already healthy: ordinary traffic must not extend the recovery grace.
  t.mock.timers.tick(1001);
  reportFailure();
  assert.equal(connection().state, "checking");
  assert.equal(probes.length, 2, "new failures can diagnose an outage after the original grace");
  probes[1](Response.json({ ok: false }, { status: 503 }));
  await setImmediate();
  assert.equal(connection().state, "down");
  assert.equal(connection().retryAt, Date.now() + 2000);
});
