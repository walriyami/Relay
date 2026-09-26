/** One numeric code format for every Relay handoff. Length is a deployment setting. */
export type CodeLength = 4 | 6;
export const DEFAULT_CODE_LENGTH: CodeLength = 6;

/** Accept whole codes only; never turn arbitrary text or a longer code into a different code. */
export function normalizeCode(raw: string, length?: CodeLength): string | null {
  const value = raw.trim();
  if (!/^(?:[0-9]{4}|[0-9]{6}|[0-9]{3}[-\s][0-9]{3})$/.test(value)) return null;
  const digits = value.replace(/[-\s]/g, "");
  return length === undefined || digits.length === length ? digits : null;
}

export function formatCode(digits: string): string {
  return digits.length === 6 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
}
