import { bytes } from "../../lib/format";
import { Field } from "../../components/ui";

const UNITS = [
  { label: "MB", size: 1024 ** 2 },
  { label: "GB", size: 1024 ** 3 },
  { label: "TB", size: 1024 ** 4 },
] as const;

/** What a size field shows: the typed amount and its unit. Bytes are derived only when saving. */
export type ByteDraft = { amount: string; unit: number };

/**
 * The largest unit that shows `value` exactly with at most two decimals. A value no unit shows
 * exactly (set through the API, say 1234 bytes) gets an approximation, which is never sent back
 * unless the administrator edits it.
 */
export function toDraft(value: number): ByteDraft {
  for (const { size } of [...UNITS].reverse()) {
    const amount = Number((value / size).toFixed(2));
    if (amount >= 1 && Math.round(amount * size) === value) return { amount: String(amount), unit: size };
  }
  return { amount: String(Number((value / UNITS[0].size).toPrecision(3))), unit: UNITS[0].size };
}

/** Whole bytes, or null when the amount isn't a positive number. */
export function fromDraft(draft: ByteDraft): number | null {
  const amount = Number(draft.amount);
  if (!draft.amount.trim() || !Number.isFinite(amount) || amount <= 0) return null;
  return Math.max(1, Math.round(amount * draft.unit));
}

/** The bytes to save when the field was changed, `undefined` when it still shows `original`. */
export function changedBytes(draft: ByteDraft, original: number): number | null | undefined {
  const shown = toDraft(original);
  if (draft.amount === shown.amount && draft.unit === shown.unit) return undefined;
  const value = fromDraft(draft);
  return value === original ? undefined : value;
}

export function ByteSizeField({
  label,
  hint,
  draft,
  original,
  onChange,
  invalid,
}: {
  label: string;
  hint?: string;
  draft: ByteDraft;
  /**
   * The saved value. A change says what it becomes, so a switched unit can't slip by unnoticed.
   * Left out when nothing is saved yet.
   */
  original?: number;
  onChange: (draft: ByteDraft) => void;
  invalid?: boolean;
}) {
  const next = original === undefined ? undefined : changedBytes(draft, original);
  const change = next ? `Now ${bytes(original!)}; saving makes it ${bytes(next)}.` : "";
  return (
    <Field label={label} hint={[hint, change].filter(Boolean).join(" ") || undefined}>
      <span className="byte-size">
        <input
          className="input"
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          required
          value={draft.amount}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange({ ...draft, amount: e.target.value })}
        />
        <select
          className="input select"
          aria-label={`${label} unit`}
          value={draft.unit}
          onChange={(e) => onChange({ ...draft, unit: Number(e.target.value) })}
        >
          {UNITS.map((u) => (
            <option key={u.label} value={u.size}>
              {u.label}
            </option>
          ))}
        </select>
      </span>
    </Field>
  );
}
