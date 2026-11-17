// Keeps the screen on while something needs this page to stay awake. A phone whose screen turns
// off suspends the page, and with it every upload; the browser releases the lock whenever the page
// is hidden, so it is taken again each time the page comes back.

let wake: WakeLockSentinel | null = null;
let wanting = false;

async function take() {
  if (!wanting || wake || document.hidden || !navigator.wakeLock) return;
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    if (!wanting) return void sentinel.release().catch(() => {});
    wake = sentinel;
    sentinel.addEventListener("release", () => {
      if (wake === sentinel) wake = null;
    });
  } catch {
    // Not allowed here (low battery, power saving, no gesture yet): the work carries on regardless.
  }
}

/** Asks to keep the screen on while `on`, and lets it sleep again once not. */
export function keepScreenOn(on: boolean) {
  if (on === wanting || typeof document === "undefined") return;
  wanting = on;
  if (on) void take();
  else {
    void wake?.release().catch(() => {});
    wake = null;
  }
}

if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void take();
  });
