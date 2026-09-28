import { dateTime } from "./format";

export const DAY = 86_400_000;
/** A duration request is still expressed in whole days; the server clamps its saved deadline. */
export function boundedOptions<T extends { value: number; label: string; short?: string }>(
  options: T[],
  deadline: number | null | undefined,
  now = Date.now(),
): { value: number; label: string; short?: string }[] {
  if (deadline == null) return options;
  if (deadline <= now) return [];
  const last = Math.ceil((deadline - now) / DAY);
  if (!options.some((option) => option.value === 0) && last > Math.max(...options.map((option) => option.value)))
    return options;
  return [
    ...options.filter((option) => option.value > 0 && option.value < last),
    { value: last, label: `Until ${dateTime(deadline)}`, short: "Until deadline" },
  ];
}

export const effectiveExpiry = (days: number | null, deadline?: number | null, now = Date.now()) =>
  days === null ? (deadline ?? null) : Math.min(now + days * DAY, deadline ?? Infinity);
