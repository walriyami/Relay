import type { Topic } from "../../shared/model.ts";

type Listener = (topics: Topic[]) => void;

/**
 * In-process change notifications per user. Publishes are coalesced for a short moment so a burst
 * (thousands of files finishing) becomes one message. A reconnecting client refetches everything,
 * so nothing needs to be stored.
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly pending = new Map<string, Set<Topic>>();
  private timer: NodeJS.Timeout | undefined;
  private readonly delayMs: number;
  constructor(delayMs = 100) {
    this.delayMs = delayMs;
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
