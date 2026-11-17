import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { coalesce } from "../client/lib/coalesce.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fake clock: timing is exact and nothing waits in real time, so a busy machine can't make a
 * timer fire early or late. `advance` moves it a millisecond at a time, letting promises settle
 * between steps as they would; `settle` moves it until `promise` settles.
 */
function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const advance = async (ms: number) => {
    // What's already due happens before the clock moves on.
    await flush();
    for (let i = 0; i < ms; i++) {
      t.mock.timers.tick(1);
      await flush();
    }
  };
  const settle = async <T>(promise: Promise<T>) => {
    let done = false;
    promise.then(
      () => (done = true),
      () => (done = true),
    );
    for (let waited = 0; !done; waited++) {
      if (waited > 10_000) throw new Error("Never settled.");
      await advance(1);
    }
    return promise;
  };
  return { advance, settle };
}

function counter(ms = 20) {
  const starts: number[] = [];
  let running = 0;
  let overlapped = false;
  const began = performance.now();
  const work = async () => {
    starts.push(performance.now() - began);
    if (running++) overlapped = true;
    await sleep(ms);
    running--;
  };
  return { work, starts, overlapped: () => overlapped };
}

test("a burst of changes becomes one run after the delay", async (t) => {
  const { settle } = clock(t);
  const { work, starts } = counter();
  const refresh = coalesce(work, { delay: 30, interval: 200 });
  const done = Array.from({ length: 10 }, () => refresh.request());
  await settle(Promise.all(done));
  assert.deepEqual(starts, [30]);
});

test("a steady stream of changes still runs once per interval, never overlapping", async (t) => {
  const { advance, settle } = clock(t);
  const { work, starts, overlapped } = counter(30);
  const refresh = coalesce(work, { delay: 20, interval: 100 });
  // A debounce that restarts on every change would never run during this stream.
  for (let elapsed = 0; elapsed < 550; elapsed += 10) {
    void refresh.request();
    await advance(10);
  }
  await settle(refresh.request());
  assert.ok(starts.length >= 4 && starts.length <= 8, `runs: ${starts.join(", ")}`);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 100, `spacing: ${starts.join(", ")}`);
  assert.equal(overlapped(), false);
});

test("an urgent request runs at once, or right after the run under way", async (t) => {
  const { advance, settle } = clock(t);
  const { work, starts, overlapped } = counter(50);
  const refresh = coalesce(work, { delay: 100, interval: 1000 });
  await settle(refresh.request(true));
  assert.deepEqual(starts, [0]);
  // Within the interval, an urgent request still doesn't wait for it.
  const second = refresh.request(true);
  await advance(10);
  // Asked while the second run is under way: served by a third run that starts after it.
  const third = refresh.request(true);
  await settle(second);
  await settle(third);
  assert.equal(starts.length, 3);
  assert.ok(starts[2] >= starts[1] + 50, `third began after the second ended: ${starts.join(", ")}`);
  assert.equal(overlapped(), false);
});

test("a request settles with the run that serves it, and cancel stops what is waiting", async (t) => {
  const { advance, settle } = clock(t);
  let fail = true;
  const refresh = coalesce(() => (fail ? Promise.reject(new Error("offline")) : Promise.resolve()), {
    delay: 10,
    interval: 10,
  });
  await assert.rejects(settle(refresh.request(true)), /offline/);
  fail = false;
  await settle(refresh.request(true));
  let ran = false;
  const stopped = coalesce(
    () => {
      ran = true;
      return Promise.resolve();
    },
    { delay: 20, interval: 20 },
  );
  const waiting = stopped.request();
  stopped.cancel();
  await settle(waiting);
  await advance(40);
  assert.equal(ran, false);
});
