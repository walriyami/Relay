import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  missed,
  stamped,
  tab,
  urls,
  type ChangeEvent,
  type ChangeStamp,
  type SessionEnded,
  type Topic,
} from "../api";
import type { Endpoint, Input, Response } from "../../shared/api";
import { coalesce, type Coalesced } from "./coalesce";
import { connection, onConnectivity, reportFailure, reportReachable } from "./connection";
import { eventStream } from "./event-stream";

const ALL: Topic[] = ["items", "links", "deliveries", "devices", "requests", "account", "activity", "codes"];
/** Told the stamp a new stream opened at, when that is why it runs; see `missed`. */
type Listener = (opened?: ChangeStamp) => void;
const listeners = new Map<Topic, Set<Listener>>();
let source: ReturnType<typeof eventStream> | undefined;
// A new principal gets a new tab id and a new stream.
let sourceTab = "";

function fire(topic: Topic, opened?: ChangeStamp) {
  listeners.get(topic)?.forEach((fn) => fn(opened));
}

/** One member event stream per tab. It marks this device online and keeps its transfers alive. */
export function connectLive() {
  if (sourceTab !== tab()) disconnectLive();
  if (source) return;
  sourceTab = tab();
  const refresh = (opened?: ChangeStamp) => {
    reportReachable();
    ALL.forEach((topic) => fire(topic, opened));
  };
  source = eventStream(urls.events(sourceTab), {
    // Whatever changed before the stream opened, it won't send: views read earlier load again.
    ready: refresh,
    // Overflow tabs still refresh their views and renew their lease on each bounded probe.
    limited: () => refresh(),
    change: (event) => {
      try {
        const { topics } = JSON.parse(event.data) as ChangeEvent;
        (topics.length ? topics : ALL).forEach((topic) => fire(topic));
      } catch {
        ALL.forEach((topic) => fire(topic));
      }
    },
    ended: (event) => {
      let reason: SessionEnded["reason"] = "signed-out";
      try {
        reason = (JSON.parse(event.data) as SessionEnded).reason;
      } catch {
        /* Keep the generic reason. */
      }
      disconnectLive();
      window.dispatchEvent(new CustomEvent<SessionEnded>("relay-session-expired", { detail: { reason } }));
    },
    failed: () => {
      reportFailure();
      // A refused probe has no SSE reason. Recheck the session so overflow tabs also sign out
      // promptly after revocation, even when they have no view queries in flight.
      fire("account");
    },
  });
}
export function disconnectLive() {
  source?.close();
  source = undefined;
}
// A successful connectivity check can shorten a network retry, but cannot bypass admission limits.
onConnectivity(() => {
  if (connection().state === "ok") source?.retryNow();
});

export function onChange(topic: Topic, fn: Listener) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic)!.add(fn);
  return () => {
    listeners.get(topic)!.delete(fn);
  };
}
/** Local changes made by this tab refresh its own views without waiting for the stream. */
export function notifyChange(topic: Topic) {
  fire(topic);
}

// The last answer to each query, kept for the signed-in member of this tab. A view opened again
// shows what it had straight away and refreshes it in the background, rather than loading from
// nothing on every visit. Bounded, least recently used first out; a new principal starts empty.
const CACHE_LIMIT = 40;
const cache = new Map<string, unknown>();
let cacheTab = "";
function cacheFor(owner: string) {
  if (cacheTab !== owner) {
    cache.clear();
    cacheTab = owner;
  }
  return cache;
}
function cached(key: string): { data: unknown } | undefined {
  const entries = cacheFor(tab());
  if (!entries.has(key)) return undefined;
  const data = entries.get(key);
  entries.delete(key);
  entries.set(key, data);
  return { data };
}
function remember(owner: string, key: string, data: unknown) {
  // An answer for someone who has since signed out belongs to no one here.
  if (owner !== tab()) return;
  const entries = cacheFor(owner);
  entries.delete(key);
  entries.set(key, data);
  if (entries.size > CACHE_LIMIT) entries.delete(entries.keys().next().value!);
}
// Answers that say something is gone or not this member's; a remembered copy is wrong after them.
const FINAL = new Set([401, 403, 404, 410]);

/**
 * Loads an endpoint and reloads it whenever one of `topics` changes. Pass `null` to load nothing.
 * `data` is the last answer this tab had for the same query, if any, or `initial` until the first
 * response arrives; `loading` is true only while there is nothing to show yet.
 *
 * Changes reload at most once a second and never while a load is under way, however fast they
 * come (an upload of many files changes items with every file); `reload` loads straight away.
 */
export function useLive<E extends Endpoint, I = Response<E>>(
  endpoint: E | null,
  input: Input<E> | null,
  topics: Topic[],
  initial: I,
): { data: Response<E> | I; loading: boolean; error: string; errorStatus: number | null; reload: () => void } {
  type State = {
    key: string;
    generation: number;
    data: Response<E> | I;
    loading: boolean;
    error: string;
    errorStatus: number | null;
  };
  const [state, setState] = useState<State>({
    key: "",
    generation: 0,
    data: initial,
    loading: !!endpoint,
    error: "",
    errorStatus: null,
  });
  const seq = useRef(0);
  const key = endpoint ? `${endpoint.path}:${JSON.stringify(input)}` : "";
  const query = useRef({ key, generation: 0 });
  if (query.current.key !== key) {
    query.current = { key, generation: query.current.generation + 1 };
    // Invalidate a prior request as soon as the new key renders, before effects have a chance to run.
    seq.current++;
  }
  const generation = query.current.generation;
  // Where a query starts: what this tab last had for it, or nothing yet.
  const start = (): State => {
    const hit = endpoint ? cached(key) : undefined;
    return {
      key,
      generation,
      data: hit ? (hit.data as Response<E>) : initial,
      loading: !!endpoint && !hit,
      error: "",
      errorStatus: null,
    };
  };
  const failed = useRef(false);
  failed.current = !!state.error;
  // Resolves with the stamp of the answer it shows, or undefined when it shows none.
  const load = useCallback((): Promise<ChangeStamp | null | undefined> => {
    if (!endpoint) return Promise.resolve(undefined);
    const n = ++seq.current;
    const owner = tab();
    return stamped(endpoint, input ?? undefined)
      .then(({ data, changes }) => {
        remember(owner, key, data);
        if (n !== seq.current || query.current.generation !== generation) return undefined;
        setState({ key, generation, data, loading: false, error: "", errorStatus: null });
        return changes;
      })
      .catch((error: Error) => {
        if (error instanceof ApiError && FINAL.has(error.status) && owner === tab()) cacheFor(owner).delete(key);
        if (n === seq.current && query.current.generation === generation)
          setState((s) => ({
            ...s,
            key,
            generation,
            loading: false,
            error: error.message,
            errorStatus: error instanceof ApiError ? error.status : null,
          }));
        return undefined;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for endpoint and input, which callers usually recreate on every render.
  }, [key, generation]);
  const refresher = useRef<Coalesced | null>(null);
  const reload = useCallback(() => {
    if (refresher.current) void refresher.current.request(true);
    else void load();
  }, [load]);
  useEffect(() => {
    setState(start());
    // The stamp of the answer shown, and a stream that opened while the next was on its way.
    let read: ChangeStamp | null | undefined;
    let opened: ChangeStamp | undefined;
    let running = false;
    let active = true;
    const run = () => {
      running = true;
      return load().then((changes) => {
        running = false;
        if (changes !== undefined) read = changes;
        const recheck = opened;
        opened = undefined;
        if (active && recheck && missed(read, recheck)) soon();
      });
    };
    const refresh = coalesce(run, { delay: 150, interval: 1000 });
    refresher.current = refresh;
    void refresh.request(true);
    const soon = () => void refresh.request();
    // A stream opening sends nothing that changed before it: load again only if this view may lack some.
    const changed = (stream?: ChangeStamp) => {
      if (!stream) soon();
      else if (running) opened = stream;
      else if (missed(read, stream)) soon();
    };
    const offs = topics.map((topic) => onChange(topic, changed));
    // Coming back loads again: a short drop may leave the stream connected, so nothing else would
    // replace what failed meanwhile. A check that finds nothing wrong reloads too, for the same reason.
    let was = connection().state;
    offs.push(
      onConnectivity(() => {
        const now = connection().state;
        // A check that found nothing wrong only reloads what failed meanwhile.
        if (now === "ok" && was !== "ok" && (was !== "checking" || failed.current)) {
          // What failed while Relay was out of reach goes back to loading, not to its error.
          setState((s) => (s.error ? { ...s, loading: true, error: "", errorStatus: null } : s));
          soon();
        }
        was = now;
      }),
    );
    const visible = () => {
      if (!document.hidden) soon();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      refresh.cancel();
      if (refresher.current === refresh) refresher.current = null;
      offs.forEach((off) => off());
      document.removeEventListener("visibilitychange", visible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resubscribe only when the query or the topics change.
  }, [load, topics.join(",")]);
  // Render the new key's starting state immediately, before effects run, so an old response can
  // never flash under new parameters.
  const visible = state.key === key && state.generation === generation ? state : start();
  return {
    data: visible.data,
    loading: visible.loading,
    error: visible.error,
    errorStatus: visible.errorStatus,
    reload,
  };
}
