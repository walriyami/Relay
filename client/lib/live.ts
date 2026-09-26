import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, call, tab, urls, type ChangeEvent, type SessionEnded, type StreamReady, type Topic } from "../api";
import type { Endpoint, Input, Response } from "../../shared/api";
import { connection, onConnectivity, reportFailure, reportReachable } from "./connection";

const ALL: Topic[] = ["items", "links", "deliveries", "devices", "requests", "account", "activity"];
const listeners = new Map<Topic, Set<() => void>>();
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 1000;
let active = false;
let sourceCleanup: (() => void) | undefined;
// The tab id the open stream was made for. A new principal gets a new tab id, and its stream.
let sourceTab = "";

function fire(topic: Topic) {
  listeners.get(topic)?.forEach((fn) => fn());
}

/**
 * Notices a stream that was cut without closing (a sleeping laptop, a Wi‑Fi handover, a proxy that
 * holds the line open): the server sends something at least every `beatMs` (from `ready`), so a
 * stream silent for a few beats is gone. `onSilent` runs once; the caller closes and reconnects.
 */
export function watchBeats(source: EventSource, onSilent: () => void) {
  let beatMs = 20_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const heard = () => {
    clearTimeout(timer);
    timer = setTimeout(onSilent, beatMs * 2.5);
  };
  const ready = (event: Event) => {
    try {
      const sent = (JSON.parse((event as MessageEvent<string>).data) as Partial<StreamReady>).beatMs;
      if (typeof sent === "number" && sent > 0) beatMs = sent;
    } catch {
      // Keep the default.
    }
    heard();
  };
  source.addEventListener("ready", ready);
  source.addEventListener("beat", heard);
  source.addEventListener("change", heard);
  heard();
  return () => {
    clearTimeout(timer);
    source.removeEventListener("ready", ready);
    source.removeEventListener("beat", heard);
    source.removeEventListener("change", heard);
  };
}

/** One member event stream per tab. It marks this device online and keeps this tab's transfers alive. */
export function connectLive() {
  if (sourceTab !== tab()) disconnectLive();
  active = true;
  if (source || retryTimer) return;
  openSource();
}

function openSource() {
  if (!active || source || retryTimer) return;
  sourceTab = tab();
  const current = new EventSource(urls.events(sourceTab));
  source = current;
  const ready = () => {
    if (source !== current) return;
    retryDelay = 1000;
    reportReachable();
    // Initial requests may also have failed while the stream was unavailable.
    ALL.forEach(fire);
  };
  const change = (event: Event) => {
    if (source !== current) return;
    try {
      const { topics } = JSON.parse((event as MessageEvent<string>).data) as ChangeEvent;
      (topics.length ? topics : ALL).forEach(fire);
    } catch {
      ALL.forEach(fire);
    }
  };
  // The server revoked this session (suspension, sign-out elsewhere, password reset): stop
  // reconnecting and let the app end the session with the reason.
  const ended = (event: Event) => {
    if (source !== current) return;
    let reason: SessionEnded["reason"] = "signed-out";
    try {
      reason = (JSON.parse((event as MessageEvent<string>).data) as SessionEnded).reason;
    } catch {
      // Keep the generic reason.
    }
    disconnectLive();
    window.dispatchEvent(new CustomEvent<SessionEnded>("relay-session-expired", { detail: { reason } }));
  };
  const reconnect = () => {
    sourceCleanup?.();
    sourceCleanup = undefined;
    source = null;
    if (retryTimer) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, 30_000);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      openSource();
    }, delay);
  };
  const error = () => {
    if (!active || source !== current) return;
    // The stream drops the moment Relay or the connection goes, often before any request fails.
    reportFailure();
    if (current.readyState === EventSource.CLOSED) reconnect();
  };
  // A stream that went quiet was cut without closing: the same as a dropped one.
  const silent = () => {
    if (!active || source !== current) return;
    reportFailure();
    reconnect();
  };
  const unwatch = watchBeats(current, silent);
  current.addEventListener("ready", ready);
  current.addEventListener("change", change);
  current.addEventListener("ended", ended);
  current.addEventListener("error", error);
  sourceCleanup = () => {
    unwatch();
    current.removeEventListener("ready", ready);
    current.removeEventListener("change", change);
    current.removeEventListener("ended", ended);
    current.removeEventListener("error", error);
    current.close();
  };
}
export function disconnectLive() {
  active = false;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  retryDelay = 1000;
  sourceCleanup?.();
  sourceCleanup = undefined;
  source = null;
}
// Once Relay can be reached again, the stream reconnects at once rather than after its backoff, and
// every view reloads (see useLive).
onConnectivity(() => {
  if (connection().state !== "ok" || !retryTimer) return;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  retryDelay = 1000;
  openSource();
});

export function onChange(topic: Topic, fn: () => void) {
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

/**
 * Loads an endpoint and reloads it whenever one of `topics` changes. Pass `null` to load nothing.
 * `data` is `initial` until the first response arrives.
 */
export function useLive<E extends Endpoint, I = Response<E>>(
  endpoint: E | null,
  input: Input<E> | null,
  topics: Topic[],
  initial: I,
): { data: Response<E> | I; loading: boolean; error: string; errorStatus: number | null; reload: () => void } {
  const [state, setState] = useState<{
    key: string;
    generation: number;
    data: Response<E> | I;
    loading: boolean;
    error: string;
    errorStatus: number | null;
  }>({
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
  const failed = useRef(false);
  failed.current = !!state.error;
  const reload = useCallback(() => {
    if (!endpoint) return;
    const n = ++seq.current;
    (call as (e: E, i?: Input<E>) => Promise<Response<E>>)(endpoint, input ?? undefined)
      .then((data) => {
        if (n === seq.current && query.current.generation === generation)
          setState({ key, generation, data, loading: false, error: "", errorStatus: null });
      })
      .catch((error: Error) => {
        if (n === seq.current && query.current.generation === generation)
          setState((s) => ({
            ...s,
            key,
            generation,
            loading: false,
            error: error.message,
            errorStatus: error instanceof ApiError ? error.status : null,
          }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for endpoint and input, which callers usually recreate on every render.
  }, [key, generation]);
  useEffect(() => {
    setState({ key, generation, data: initial, loading: !!endpoint, error: "", errorStatus: null });
    reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(reload, 150);
    };
    const offs = topics.map((topic) => onChange(topic, soon));
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
      clearTimeout(timer);
      offs.forEach((off) => off());
      document.removeEventListener("visibilitychange", visible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resubscribe only when the reload function or the topics change.
  }, [reload, topics.join(",")]);
  // Render the new key's empty/loading state immediately, before effects run, so an old response
  // can never flash under new parameters.
  const visible =
    state.key === key && state.generation === generation
      ? state
      : { key, generation, data: initial, loading: !!endpoint, error: "", errorStatus: null };
  return {
    data: visible.data,
    loading: visible.loading,
    error: visible.error,
    errorStatus: visible.errorStatus,
    reload,
  };
}
