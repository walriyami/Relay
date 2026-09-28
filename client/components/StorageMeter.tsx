// How much of their space a member has used: against their limit when they have one, otherwise
// against what is left on the server for everyone.
import type { Me } from "../api";
import { bytes } from "../lib/format";
import { ProgressBar } from "./ui";

type Usage = Me["usage"];

/** The whole picture in words. Uploads still arriving are only worth a mention while there are any. */
export function storageSummary(usage: Usage, limit: number | null) {
  const used = usage.used + usage.reserved;
  return [
    limit === null ? `${bytes(used)} used · ${bytes(usage.available)} free` : `${bytes(used)} of ${bytes(limit)} used`,
    usage.reserved > 0 && `${bytes(usage.reserved)} uploading`,
    limit !== null && used > limit && "Over limit",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Used (including uploads still arriving), the most they could hold, and how it reads. */
export function storageOf(me: Pick<Me, "usage" | "user">) {
  const used = me.usage.used + me.usage.reserved;
  const limit = me.user.limits.storage;
  const max = limit ?? used + me.usage.available;
  return {
    used,
    max,
    limit,
    // Near the end of the space, it says so in words as well as in the bar.
    tight: max > 0 && me.usage.available < max * 0.1,
    /** Short enough for a menu: what matters most, in a few words. */
    figure:
      limit === null
        ? `${bytes(me.usage.available)} free`
        : used > limit
          ? `Over limit · ${bytes(limit)}`
          : `${bytes(used)} of ${bytes(limit)}`,
    summary: storageSummary(me.usage, limit),
  };
}

export function StorageMeter({ me, compact = false }: { me: Pick<Me, "usage" | "user">; compact?: boolean }) {
  const storage = storageOf(me);
  return (
    <div className={`storage-meter${compact ? " is-compact" : ""}${storage.tight ? " is-tight" : ""}`}>
      <ProgressBar value={storage.used} max={storage.max} label="Storage used" minVisible />
      <span className="storage-meter-text">{storage.summary}</span>
    </div>
  );
}
