import type { ServiceOperations } from "../../shared/model.ts";

/** Bounded, process-local diagnostics. Never retain URLs, account IDs, content or exception text. */
export class Operations {
  readonly intervalMs: number;
  constructor(intervalMs = 60_000) {
    this.intervalMs = intervalMs;
  }
  readonly started = Date.now();
  private buckets = new Map<number, { requests: number; failures: number; limited: number }>();
  private stages = new Map<string, ServiceOperations["maintenance"][number]>();
  reconciliation = { checked: 0, missing: 0, removedOrphans: 0 };

  response(status: number, now = Date.now()) {
    const minute = Math.floor(now / 60_000);
    for (const key of this.buckets.keys()) if (key <= minute - 60) this.buckets.delete(key);
    const bucket = this.buckets.get(minute) ?? { requests: 0, failures: 0, limited: 0 };
    bucket.requests++;
    if (status >= 500) bucket.failures++;
    if (status === 429) bucket.limited++;
    this.buckets.set(minute, bucket);
  }

  async run(name: string, work: () => unknown, onError: (error: unknown) => void) {
    const stage = this.stages.get(name) ?? { name, attempted: 0, succeeded: null, failed: false, failures: 0 };
    stage.attempted = Date.now();
    this.stages.set(name, stage);
    try {
      await work();
      stage.succeeded = Date.now();
      stage.failed = false;
    } catch (error) {
      stage.failed = true;
      stage.failures++;
      onError(error);
    }
  }

  snapshot(now = Date.now()): ServiceOperations {
    const recent = { requests: 0, failures: 0, limited: 0 };
    for (const [minute, bucket] of this.buckets) {
      if (minute <= Math.floor(now / 60_000) - 60) continue;
      recent.requests += bucket.requests;
      recent.failures += bucket.failures;
      recent.limited += bucket.limited;
    }
    return {
      maintenanceIntervalMs: this.intervalMs,
      started: this.started,
      sampled: now,
      memoryBytes: process.memoryUsage().rss,
      recent,
      reconciliation: { ...this.reconciliation },
      maintenance: [...this.stages.values()].map((stage) => ({ ...stage })),
    };
  }
}
