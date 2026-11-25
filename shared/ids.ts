/** Two hexadecimal digits for each byte value. */
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));
/**
 * Random bytes drawn in one go and handed out ten per id. Asking the system for ten bytes at a
 * time, and building the text a character at a time, made a long file list's ids a noticeable part
 * of creating it; every id still gets bytes no other id had.
 */
const pool = new Uint8Array(4096);
let used = pool.length;

/** RFC 9562 UUIDv7: time-ordered, so ids sort by creation and index well. */
export function uuidv7(now = Date.now()): string {
  if (used + 10 > pool.length) {
    crypto.getRandomValues(pool);
    used = 0;
  }
  const r = used;
  used += 10;
  const time: string[] = [];
  let t = now;
  for (let i = 5; i >= 0; i--) {
    time[i] = HEX[t % 256];
    t = Math.floor(t / 256);
  }
  return (
    time[0] +
    time[1] +
    time[2] +
    time[3] +
    "-" +
    time[4] +
    time[5] +
    "-" +
    HEX[(pool[r] & 0x0f) | 0x70] +
    HEX[pool[r + 1]] +
    "-" +
    HEX[(pool[r + 2] & 0x3f) | 0x80] +
    HEX[pool[r + 3]] +
    "-" +
    HEX[pool[r + 4]] +
    HEX[pool[r + 5]] +
    HEX[pool[r + 6]] +
    HEX[pool[r + 7]] +
    HEX[pool[r + 8]] +
    HEX[pool[r + 9]]
  );
}
