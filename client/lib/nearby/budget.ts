/** Logical fallback payload bytes owned by this tab, including completed receipts. */
const MEMORY_BYTES = 2 * 1024 ** 3;

export interface ReceiveReservation {
  /** Reserve these entries together, without charging an entry twice on resume. */
  hold(entries: Record<string, number>): boolean;
  /** Release once, after storage work has settled and receipts are no longer retained. */
  release(): void;
}

export class ReceiveBudget {
  private held = 0;
  private readonly limit: number;

  constructor(limit = MEMORY_BYTES) {
    this.limit = limit;
  }

  reserve(entries: Record<string, number>): ReceiveReservation | null {
    let released = false;
    let bytes = 0;
    const sizes = new Map<string, number>();
    const reservation: ReceiveReservation = {
      hold: (entries) => {
        if (released) return false;
        let more = 0;
        for (const [key, size] of Object.entries(entries)) {
          if (!Number.isSafeInteger(size) || size < 0 || (sizes.has(key) && sizes.get(key) !== size)) return false;
          if (!sizes.has(key)) more += size;
        }
        if (!Number.isSafeInteger(more) || more > this.limit - this.held) return false;
        // No await between checking the shared total and claiming it.
        this.held += more;
        bytes += more;
        for (const [key, size] of Object.entries(entries)) sizes.set(key, size);
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        this.held -= bytes;
        sizes.clear();
      },
    };
    return reservation.hold(entries) ? reservation : null;
  }
}
