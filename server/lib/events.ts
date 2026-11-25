import { createHash, randomBytes } from "node:crypto";
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
  // Counts publishes: each user's own, and those to everyone. A member's stamp counts only what they
  // are told, so it never shows how busy anyone else is. A restart starts a new count, and each
  // member's is their own, told apart by what comes before the count.
  private readonly boot = randomBytes(6).toString("base64url");
  private readonly sequences = new Map<string, number>();
  private broadcasts = 0;
  constructor(delayMs = 100) {
    this.delayMs = delayMs;
  }

  /**
   * Where the stream of `userId`'s changes stands. A read that begins after taking this sees every
   * change it counts; a stream opened after it delivers every change it doesn't. So a view read at
   * or after the stamp a new stream reports has missed nothing, and needn't load again.
   */
  stamp(userId: string): ChangeStamp {
    const member = createHash("sha256").update(`${this.boot} ${userId}`).digest("base64url").slice(0, 8);
    return `${this.boot}-${member}.${(this.sequences.get(userId) ?? 0) + this.broadcasts}`;
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
    this.sequences.set(userId, (this.sequences.get(userId) ?? 0) + 1);
    this.queue(userId, topics);
  }

  /**
   * Shared capacity changes affect every connected member, regardless of who saved them. It counts
   * once for everyone, so a member who isn't listening now still loads afresh when they next are.
   */
  broadcast(...topics: Topic[]) {
    this.broadcasts++;
    for (const userId of this.listeners.keys()) this.queue(userId, topics);
  }

  private queue(userId: string, topics: Topic[]) {
    let set = this.pending.get(userId);
    if (!set) this.pending.set(userId, (set = new Set()));
    for (const topic of topics) set.add(topic);
    this.timer ??= setTimeout(() => this.flush(), this.delayMs);
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
