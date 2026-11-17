// What GET /api/health reports, which the container health check and the hosting system act on.
//
// "unavailable" (503) is kept for what makes Relay unusable: its database can't be read or is
// damaged, or the data folder is gone. A restart is the right first step for those. Everything a
// restart can't fix (a full disk, damaged files, a failing cleanup job) is "degraded" (still 200),
// so the hosting system doesn't restart Relay in a loop; the admin overview explains each one.
import { statfs } from "node:fs/promises";
import type { Context } from "./context.ts";
import { build } from "./build-info.ts";
import { isDiskLow, type Health, type HealthProblem } from "../shared/model.ts";

/** A write happens at most this often when writes are working, so the probe costs next to nothing. */
const PROBE_MS = 60_000;

export function createHealth(ctx: Context) {
  const { db, config } = ctx;
  let probed = 0;
  let last: Health["status"] = "healthy";

  return async function check(): Promise<Health> {
    const now = Date.now();
    const problems = new Set<HealthProblem>();
    let usable = true;
    try {
      db.value("SELECT 1");
    } catch {
      usable = false;
    }
    // Reads keep working on a disk that refuses writes, so write a little now and then, and straight
    // away after a failed write, which also clears the failure once writes work again.
    if (usable && (db.storageFailure || now - probed >= PROBE_MS)) {
      probed = now;
      try {
        db.setSetting("health_probe", String(now));
      } catch {
        // Recorded in db.storageFailure when it is a storage fault.
      }
    }
    if (db.storageFailure?.damaged) usable = false;
    if (!usable || db.storageFailure) problems.add("database");
    try {
      const disk = await statfs(config.root);
      if (isDiskLow(disk.bavail * disk.bsize, disk.blocks * disk.bsize)) problems.add("disk-space");
    } catch {
      usable = false;
      problems.add("disk-space");
    }
    if (ctx.blobs.degraded()) problems.add("stored-files");
    const usage = ctx.usage.status();
    if (usage.failed || usage.discarded > 0) problems.add("usage-records");
    const stale = Math.max(5 * 60_000, 3 * config.sweepMs);
    if (ctx.operations.snapshot(now).maintenance.some((stage) => stage.failed || now - stage.attempted > stale))
      problems.add("maintenance");

    const status: Health["status"] = !usable ? "unavailable" : problems.size ? "degraded" : "healthy";
    const list = [...problems];
    if (status !== last) {
      const detail = { status, was: last, problems: list, database: db.storageFailure?.message };
      if (status === "healthy") ctx.log.info(detail, "Relay is healthy again");
      else ctx.log.warn(detail, `Relay is ${status}`);
      last = status;
    }
    return { ok: status !== "unavailable", status, problems: list, version: build.version, commit: build.commit };
  };
}
