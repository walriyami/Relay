/** Every Relay handoff code is six digits, shown as 123-456. */
export const CODE_LENGTH = 6;

/** Accept whole codes only; never turn arbitrary text or a longer code into a different code. */
export function normalizeCode(raw: string): string | null {
  const value = raw.trim();
  if (!/^(?:[0-9]{6}|[0-9]{3}[-\s][0-9]{3})$/.test(value)) return null;
  return value.replace(/[-\s]/g, "");
}

export function formatCode(digits: string): string {
  return digits.length === 6 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
}
