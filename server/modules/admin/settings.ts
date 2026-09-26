import type { Context } from "../../context.ts";
import { DEFAULTS, type AdminOverview } from "../../../shared/model.ts";

export type Limits = AdminOverview["limits"];

/** Product-facing limits kept in `settings` under these keys, as decimal strings. */
const FALLBACKS: Limits = {
  capacity: DEFAULTS.capacityBytes,
};

export function limitsOf(ctx: Context): Limits {
  const limits = { ...FALLBACKS };
  for (const key of Object.keys(FALLBACKS) as (keyof Limits)[]) {
    const stored = ctx.db.setting(key);
    if (stored !== undefined) limits[key] = Number(stored);
  }
  return limits;
}

export function setLimits(ctx: Context, changes: Partial<Limits>) {
  ctx.db.tx(() => {
    for (const [key, value] of Object.entries(changes)) if (value !== undefined) ctx.db.setSetting(key, String(value));
  });
}
