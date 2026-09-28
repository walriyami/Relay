/**
 * Runs `work` when asked, folding requests together: never two runs at once, and no run sooner than
 * `interval` after the last one began. A request waits `delay` for others to join it, and later
 * requests never push that deadline back, so a steady stream of changes still refreshes on time.
 * An urgent request (a user's own action) skips the waiting, but still never overlaps a run.
 *
 * `request` resolves or rejects with the first run that starts after it.
 */
export function coalesce(work: () => Promise<unknown>, { delay, interval }: { delay: number; interval: number }) {
  type Run = { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let urgent = false;
  let lastStart = -Infinity;
  let cancelled = false;
  // The run that will serve requests made now.
  let next: Run | null = null;

  const run = () => {
    clearTimeout(timer);
    timer = undefined;
    const serving = next!;
    next = null;
    urgent = false;
    busy = true;
    lastStart = performance.now();
    // A synchronous throw settles its requests like a rejection.
    void Promise.resolve()
      .then(work)
      .then(serving.resolve, serving.reject)
      .finally(() => {
        busy = false;
        schedule();
      });
  };
  const schedule = () => {
    if (busy || cancelled || !next) return;
    if (urgent) return run();
    if (timer) return;
    const now = performance.now();
    timer = setTimeout(run, Math.max(delay, lastStart + interval - now));
  };

  return {
    request(now = false): Promise<void> {
      if (cancelled) return Promise.resolve();
      if (!next) {
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        // Callers that don't wait for the result shouldn't surface its failure as unhandled.
        promise.catch(() => {});
        next = { promise, resolve, reject };
      }
      const { promise } = next;
      if (now) urgent = true;
      schedule();
      return promise;
    },
    /** Stops future runs; a run under way still settles its requests, and waiting ones resolve. */
    cancel() {
      cancelled = true;
      clearTimeout(timer);
      next?.resolve();
      next = null;
    },
  };
}
export type Coalesced = ReturnType<typeof coalesce>;
