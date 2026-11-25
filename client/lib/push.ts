import { useEffect, useSyncExternalStore } from "react";
import { api, ApiError, call } from "../api";
import { isIOS, isInstalled, serviceWorker } from "./pwa";

// Push notifications for this device (server/modules/push): turned on here, in Settings or from the
// bell's offer, and off again the same way or by signing out.

/**
 * ready: this browser can get notifications. install-first: an iPhone or iPad in Safari, which only
 * allows them in the Home Screen app. unsupported: this browser has no push at all.
 */
export type PushSupport = "ready" | "install-first" | "unsupported";
export type PushState = {
  support: PushSupport;
  permission: NotificationPermission | "unsupported";
  /** Notifications are on for this device: the browser is subscribed and the server knows it. */
  on: boolean;
  /** The first check has finished, so `on` can be trusted. */
  checked: boolean;
  busy: boolean;
};

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const capable =
    isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIOS && !isInstalled()) return "install-first";
  return capable ? "ready" : "unsupported";
}
const permission = () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

let state: PushState = { support: pushSupport(), permission: permission(), on: false, checked: false, busy: false };
const listeners = new Set<() => void>();
function set(patch: Partial<PushState>) {
  state = { ...state, ...patch, permission: permission() };
  listeners.forEach((fn) => fn());
}
export const pushState = () => state;

const toKey = (base64url: string) => {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) =>
  !!a && a.byteLength === b.length && new Uint8Array(a).every((byte, i) => byte === b[i]);

async function registration() {
  const reg = await serviceWorker();
  if (!reg)
    throw new Error("Notifications need Relay’s app support, which this browser didn’t start. Reload and try again.");
  return reg;
}

/** This browser's subscription for the server's current key, made when `create` allows. */
async function subscription(key: string, create: boolean) {
  const reg = await registration();
  const wanted = toKey(key);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, wanted)) {
    // The server has a new key (its key file was replaced): this subscription can't be used.
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
  return sub;
}

async function register(sub: PushSubscription) {
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await call(api.push.subscribe, { body: { endpoint: json.endpoint, keys: json.keys } });
}

/**
 * Registers this browser's subscription. If the server says its address belongs to another account
 * (someone else claimed it while this browser had none on file), a new subscription gets a new address.
 */
async function registerOrRenew(sub: PushSubscription, key: string) {
  try {
    await register(sub);
    return sub;
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) throw error;
    await sub.unsubscribe().catch(() => {});
    const fresh = await subscription(key, true);
    if (!fresh) throw error;
    await register(fresh);
    return fresh;
  }
}

let checking: Promise<void> | null = null;
/**
 * Works out whether notifications are on, and repairs what can be repaired without asking: a browser
 * that replaced its subscription gets the new one registered.
 */
export function checkPush() {
  return (checking ??= (async () => {
    try {
      if (state.support !== "ready") return;
      const status = await call(api.push.status);
      if (!status.subscribed) return set({ on: false });
      if (permission() !== "granted") {
        // Blocked in the browser's settings since: stop sending to it.
        await call(api.push.unsubscribe).catch(() => {});
        return set({ on: false });
      }
      const sub = await subscription(status.key, true);
      if (sub) await register(sub);
      set({ on: !!sub });
    } catch {
      // Unknown for now; Settings shows it as off and can be turned on again.
    } finally {
      set({ checked: true });
      checking = null;
    }
  })());
}

/** Turns notifications on for this device. Call it from a tap: browsers only ask then. */
export async function enablePush() {
  set({ busy: true });
  try {
    const answer = permission() === "granted" ? "granted" : await Notification.requestPermission();
    if (answer !== "granted")
      throw new Error(
        answer === "denied"
          ? "Notifications are blocked for Relay. Allow them in this browser’s site settings, then try again."
          : "Notifications weren’t allowed.",
      );
    const status = await call(api.push.status);
    const sub = await subscription(status.key, true);
    if (!sub) throw new Error("This browser couldn’t turn on notifications.");
    await registerOrRenew(sub, status.key);
    set({ on: true });
  } finally {
    set({ busy: false, checked: true });
  }
}

/** Turns notifications off for this device. */
export async function disablePush() {
  set({ busy: true });
  try {
    await call(api.push.unsubscribe);
    const reg = await serviceWorker();
    await (await reg?.pushManager.getSubscription())?.unsubscribe().catch(() => {});
    set({ on: false });
  } finally {
    set({ busy: false });
  }
}

/** On sign-out: this browser stops listening (the server already forgets it with the session). */
export async function forgetPush() {
  try {
    const reg = await Promise.race([serviceWorker(), new Promise<null>((r) => setTimeout(() => r(null), 1000))]);
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  } catch {
    // Nothing to forget.
  }
  set({ on: false, checked: false });
}

export const sendTestPush = () => call(api.push.test);

export function usePush() {
  useEffect(() => {
    if (!state.checked) void checkPush();
  }, []);
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

// The bell offers notifications once; after an answer, or "Not now", only Settings does.
const ASKED = "relay.pushOffered";
export function pushOffered() {
  try {
    return !!localStorage.getItem(ASKED);
  } catch {
    return true;
  }
}
export function markPushOffered() {
  try {
    localStorage.setItem(ASKED, String(Date.now()));
  } catch {
    // Private mode: the offer may come back next time.
  }
  set({});
}
