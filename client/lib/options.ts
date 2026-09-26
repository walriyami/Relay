// The choices offered for link lifetimes and for how long uploads stay in Files. Every screen that
// asks one of these questions offers the same set.

/** How long a new or extended link keeps working. Links can also be kept until turned off. */
export const LINK_DAYS = [1, 7, 30, 90];
/** How long uploads stay in Files before moving to Trash; 0 keeps them until deleted. */
export const KEEP_DAYS = [0, 1, 7, 30, 90, 365];

export const days = (n: number) => (n === 365 ? "1 year" : n === 1 ? "1 day" : `${n} days`);
const shortDays = (n: number) => (n === 365 ? "1 yr" : `${n} d`);
export const keepLabel = (n: number) => (n ? days(n) : "Forever");

/** The presets, plus a stored value that isn't one, so a control never shows a false choice. */
export const withCurrent = (presets: number[], current: number) =>
  presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);

export const linkOptions = (current?: number) =>
  (current === undefined ? LINK_DAYS : withCurrent(LINK_DAYS, current)).map((value) => ({ value, label: days(value) }));

/**
 * Segmented options for a link's lifetime, ending with "Never" (0, as segmented values can't be
 * null; see `fromSegment`). `short` labels fit five choices on a phone.
 */
export const linkLifeOptions = (current?: number | null) => [
  ...(current ? withCurrent(LINK_DAYS, current) : LINK_DAYS).map((value) => ({
    value,
    label: days(value),
    short: shortDays(value),
  })),
  { value: 0, label: "Never" },
];
/** A link lifetime to and from its segmented value: null (no expiry) is 0. */
export const toSegment = (days: number | null) => days ?? 0;
export const fromSegment = (value: number) => value || null;
/** "Expires in 7 days", "Never expires": how long a link will work, as a choice. */
export const linkLifeLabel = (n: number | null) => (n === null ? "Never expires" : `Expires in ${days(n)}`);
/** Segmented options for keeping uploads; `short` labels keep six choices on one line on a phone. */
export const keepOptions = (current: number | null) =>
  withCurrent(KEEP_DAYS, current || 0).map((value) => ({
    value,
    label: keepLabel(value),
    ...(value ? { short: shortDays(value) } : {}),
  }));
