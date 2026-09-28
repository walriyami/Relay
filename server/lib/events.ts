import { randomBytes } from "node:crypto";
import type { ChangeStamp, Topic } from "../../shared/model.ts";

type Listener = (topics: Topic[]) => void;

/**
 * In-process change notifications per user. Publishes are coalesced for a short moment so a burst
 * (thousands of files finishing) becomes one message. A reconnecting client refetches whatever it
 * read before the stream opened (see `stamp`), so nothing needs to be stored.
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly pending = new Map<string, Set<Topic>>();
  private timer: NodeJS.Timeout | undefined;
  private readonly delayMs: number;
  // Counts publishes. A restart starts a new count, told apart by the boot.
  private readonly boot = randomBytes(6).toString("base64url");
  private sequence = 0;
  constructor(delayMs = 100) {
    this.delayMs = delayMs;
  }

  /**
   * Where the stream of changes stands. A read that begins after taking this sees every change it
   * counts; a stream opened after it delivers every change it doesn't. So a view read at or after
   * the stamp a new stream reports has missed nothing, and needn't load again.
   */
  stamp(): ChangeStamp {
    return `${this.boot}.${this.sequence}`;
  }

  subscribe(userId: string, listener: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(userId);
    };
  }

  publish(userId: string, ...topics: Topic[]) {
    this.sequence++;
    let set = this.pending.get(userId);
    if (!set) this.pending.set(userId, (set = new Set()));
    for (const topic of topics) set.add(topic);
    this.timer ??= setTimeout(() => this.flush(), this.delayMs);
  }

  /** Shared capacity changes affect every connected member, regardless of who saved them. */
  broadcast(...topics: Topic[]) {
    for (const userId of this.listeners.keys()) this.publish(userId, ...topics);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = [...this.pending];
    this.pending.clear();
    for (const [userId, topics] of batch)
      for (const listener of this.listeners.get(userId) ?? []) listener([...topics]);
  }

  close() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}
