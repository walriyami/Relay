import assert from "node:assert/strict";
import test from "node:test";
import { coalesce } from "../client/lib/coalesce.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

test("a burst of changes becomes one run after the delay", async () => {
  const { work, starts } = counter();
  const refresh = coalesce(work, { delay: 30, interval: 200 });
  const done = Array.from({ length: 10 }, () => refresh.request());
  await Promise.all(done);
  assert.equal(starts.length, 1);
  assert.ok(starts[0] >= 25, `waited for the burst: ${starts[0]}`);
});

test("a steady stream of changes still runs once per interval, never overlapping", async () => {
  const { work, starts, overlapped } = counter(30);
  const refresh = coalesce(work, { delay: 20, interval: 100 });
  // A debounce that restarts on every change would never run during this stream.
  const until = performance.now() + 550;
  while (performance.now() < until) {
    void refresh.request();
    await sleep(10);
  }
  await refresh.request();
  assert.ok(starts.length >= 4 && starts.length <= 8, `runs: ${starts.join(", ")}`);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 95, `spacing: ${starts.join(", ")}`);
  assert.equal(overlapped(), false);
});

test("an urgent request runs at once, or right after the run under way", async () => {
  const { work, starts, overlapped } = counter(50);
  const refresh = coalesce(work, { delay: 100, interval: 1000 });
  await refresh.request(true);
  assert.equal(starts.length, 1);
  assert.ok(starts[0] < 10);
  // Within the interval, an urgent request still doesn't wait for it.
  const second = refresh.request(true);
  await sleep(10);
  // Asked while the second run is under way: served by a third run that starts after it.
  const third = refresh.request(true);
  await second;
  await third;
  assert.equal(starts.length, 3);
  assert.ok(starts[2] >= starts[1] + 45, `third began after the second ended: ${starts.join(", ")}`);
  assert.equal(overlapped(), false);
});

test("a request settles with the run that serves it, and cancel stops what is waiting", async () => {
  let fail = true;
  const refresh = coalesce(() => (fail ? Promise.reject(new Error("offline")) : Promise.resolve()), {
    delay: 10,
    interval: 10,
  });
  await assert.rejects(refresh.request(true), /offline/);
  fail = false;
  await refresh.request(true);
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
  await waiting;
  await sleep(40);
  assert.equal(ran, false);
});
