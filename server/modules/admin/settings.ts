import type { Context } from "../../context.ts";
import { DEFAULTS, type AdminOverview, type MemberDefaults } from "../../../shared/model.ts";

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

/** What members got before anyone chose otherwise. */
const BUILT_IN: MemberDefaults = {
  quota: DEFAULTS.quotaBytes,
  retentionDays: null,
  linkDays: DEFAULTS.linkDays,
  trashDays: DEFAULTS.trashDays,
};

/** What a new member starts with: `memberDefaults` in `settings`, as JSON, over the built-in values. */
export function memberDefaultsOf(ctx: Context): MemberDefaults {
  const stored = ctx.db.setting("memberDefaults");
  return { ...BUILT_IN, ...(stored ? (JSON.parse(stored) as Partial<MemberDefaults>) : {}) };
}

/** Changes only the values given; the rest stay as they were. */
export function setMemberDefaults(ctx: Context, changes: Partial<MemberDefaults>) {
  ctx.db.tx(() => {
    const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    ctx.db.setSetting("memberDefaults", JSON.stringify({ ...memberDefaultsOf(ctx), ...defined }));
  });
}
