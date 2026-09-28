// How much of their space a member has used: against their limit when they have one, otherwise
// against what is left on the server for everyone.
import type { Me } from "../api";
import { bytes } from "../lib/format";
import { ProgressBar } from "./ui";

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
    summary:
      limit === null
        ? `${bytes(me.usage.used)} saved · ${bytes(me.usage.reserved)} reserved · ${bytes(me.usage.available)} free`
        : `${bytes(me.usage.used)} saved · ${bytes(me.usage.reserved)} reserved of ${bytes(limit)}${used > limit ? " · Over limit" : ""}`,
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
