// The choices offered for link lifetimes, how long uploads stay in Files and how long Trash keeps
// them. Every screen that asks one of these questions offers the same set, within the limits the
// administrator gave the member: past a limit nothing is offered, and "Never" only without one.

/** How long a new or extended link keeps working, before "Never". */
export const LINK_DAYS = [1, 7, 30, 90];
/** How long uploads stay in Files before moving to Trash, before "Never". */
export const KEEP_DAYS = [1, 7, 30, 90, 365];
/** How long Trash keeps what was deleted or expired, before it is gone for good. */
export const TRASH_DAYS = [7, 30, 90, 365];
/** Limits the administrator can set on links and uploads, before "No limit". */
export const LIMIT_LINK_DAYS = [1, 7, 30, 90];
export const LIMIT_KEEP_DAYS = [7, 30, 90, 365];

export const days = (n: number) => (n === 365 ? "1 year" : n === 1 ? "1 day" : `${n} days`);
export const shortDays = (n: number) => (n === 365 ? "1 yr" : `${n} d`);

/** The presets, plus a stored value that isn't one, so a control never shows a false choice. */
export const withCurrent = (presets: number[], current: number) =>
  presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);

/**
 * The durations to offer: presets up to the limit and the limit itself, plus the current value if
 * it is allowed, in order; then 0 for "never", only when there is no limit (`max` null).
 */
export function durations(presets: number[], current: number | null, max: number | null) {
  const values = new Set(max === null ? presets : [...presets.filter((d) => d < max), max]);
  if (current && (max === null || current <= max)) values.add(current);
  const sorted = [...values].sort((a, b) => a - b);
  return max === null ? [...sorted, 0] : sorted;
}

/** What a limit allows, as a hint under the choice it limits. */
export const limitHint = (max: number) => `Your administrator allows up to ${days(max)}.`;

/** A lifetime to and from its segmented value: null (never expires) is 0. */
export const toSegment = (days: number | null) => days ?? 0;
export const fromSegment = (value: number) => value || null;

const segmentOptions = (values: number[]) =>
  values.map((value) => (value ? { value, label: days(value), short: shortDays(value) } : { value, label: "Never" }));

/**
 * Segmented options for a link's lifetime, ending with "Never" when allowed (0, as segmented values
 * can't be null). `short` labels fit the choices on a phone.
 */
export const linkLifeOptions = (current: number | null | undefined, max: number | null) =>
  segmentOptions(durations(LINK_DAYS, current ?? null, max));

/** Segmented options for how long uploads stay in Files, ending with "Never" when allowed. */
export const keepOptions = (current: number | null, max: number | null) =>
  segmentOptions(durations(KEEP_DAYS, current, max));

export const trashOptions = (current: number) =>
  withCurrent(TRASH_DAYS, current).map((value) => ({ value, label: days(value) }));

/** Request URLs share the administrator’s link cap and always expire. */
export const requestOptions = (max: number | null = null) =>
  durations(LINK_DAYS, null, max)
    .filter((value) => value > 0)
    .map((value) => ({ value, label: days(value) }));
