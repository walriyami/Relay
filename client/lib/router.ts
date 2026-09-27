import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

// Path routing with the History API. Modals add their own history entry so the
// browser Back button closes the top modal before it leaves the page.
const listeners = new Set<() => void>();
let path = typeof location !== "undefined" ? location.pathname : "/";
/** The query last reported to listeners, so Back or Forward that changes only the query is seen. */
let search = typeof location !== "undefined" ? location.search : "";
const emit = () => {
  search = location.search;
  listeners.forEach((fn) => fn());
};

type Layer = { id: number; close: () => void; url?: string };
const layers: Layer[] = [];
let serial = 0;
// Every open modal shares ONE history entry on top of the page entry. Back
// closes the top modal; if more remain, the shared entry is pushed again.
// This avoids counting multiple async history moves, which raced when one
// modal closed while another opened in the same tick.
let entryActive = false;
let ignorePops = 0;
let dropScheduled = false;
// After a reload, the entry that was a popup's (over its page's own entry) waits for that popup to
// reopen and take it back, instead of the page adding another entry for it.
let restored = false;
let adopt = false;

function isModalState() {
  return Boolean((history.state as { relayModal?: unknown } | null)?.relayModal);
}

if (typeof window !== "undefined") {
  if (isModalState()) {
    // A popup with its own address (/files/<id>) reopens into this entry. A popup without one sat
    // on an entry for the same address as the page below it, so leave it for that page.
    if (location.pathname.split("/").filter(Boolean).length > 1) restored = true;
    else {
      ignorePops++;
      history.back();
    }
  }
  window.addEventListener("popstate", () => {
    if (ignorePops > 0) {
      ignorePops--;
      return;
    }
    if (entryActive && !isModalState()) {
      // Back left the shared modal entry: close the top modal.
      entryActive = false;
      const top = layers.pop();
      top?.close();
      if (layers.length) {
        // The popups still open keep the address of the one that has one (an item under a preview).
        history.pushState({ relayModal: 1 }, "", layers.find((l) => l.url)?.url ?? location.href);
        entryActive = true;
      }
    } else if (isModalState()) {
      // Forward into a stale modal entry; treat it as the plain page.
      history.replaceState(null, "", location.href);
      if (layers.length && !entryActive) {
        history.pushState({ relayModal: 1 }, "", location.href);
        entryActive = true;
      }
    } else if (layers.length) {
      // Moved to another page while modals were open.
      while (layers.length) layers.pop()!.close();
    }
    // A change of query alone (Back from /?login=…) matters to the screens that read it.
    if (location.pathname !== path || location.search !== search) {
      path = location.pathname;
      emit();
    }
  });
}

/** The shared entry shows `url` when the first modal has one, so that modal can be reloaded or shared. */
function ensureEntry(url?: string) {
  if (entryActive) return;
  if (adopt) {
    adopt = false;
    history.replaceState({ relayModal: 1 }, "", url ?? location.href);
  } else history.pushState({ relayModal: 1 }, "", url ?? location.href);
  entryActive = true;
}

/**
 * Reads a modal's address such as /files/<id> left by a reload or a shared URL. The page itself
 * becomes the entry underneath, and the returned id should open the modal, which pushes its
 * address again; Back then closes it and stays on the page.
 */
export function takeModalAddress(page: string): string | null {
  // An open modal's own address was pushed by the modal, not left by a reload.
  if (entryActive || adopt) return null;
  const match = location.pathname.startsWith(page + "/") ? location.pathname.slice(page.length + 1) : "";
  if (!match || match.includes("/")) return null;
  if (restored) {
    // Reloaded with the popup open: its entry is still on top of the page's, so the popup reuses it.
    restored = false;
    adopt = true;
  } else history.replaceState(null, "", page + location.search);
  path = page;
  emit();
  return decodeURIComponent(match);
}

/** The address from takeModalAddress won't open anything after all: show the page's own address. */
export function releaseModalAddress(page: string) {
  if (!adopt) return;
  adopt = false;
  // The entry below is the page itself; stepping back to it leaves no dead Back step.
  if (history.length > 1) {
    ignorePops++;
    history.back();
  } else history.replaceState(null, "", page + location.search);
}

// When the last modal closes, drop the shared entry, but only after the
// current tick so a modal that immediately replaces it can reuse the entry.
function scheduleDrop() {
  if (dropScheduled) return;
  dropScheduled = true;
  queueMicrotask(() => {
    dropScheduled = false;
    if (layers.length || !entryActive) return;
    entryActive = false;
    if (isModalState()) {
      ignorePops++;
      history.back();
    }
  });
}

/** Smooth scrolling, or a jump for people who asked their system for less motion. */
export const scrollMotion = (): ScrollBehavior =>
  matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

/**
 * After navigating, show the top of the page, or the element a "#id" names. The page may still be
 * loading (Settings loads on first visit), so the element is looked for over a few frames.
 */
function scrollToTarget(to: string) {
  const hash = to.split("#")[1];
  if (!hash) return window.scrollTo({ top: 0 });
  const id = decodeURIComponent(hash);
  const started = performance.now();
  const find = () => {
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ block: "start" });
    else if (performance.now() - started < 3000) requestAnimationFrame(find);
  };
  find();
}

export function navigate(to: string, replace = false) {
  if (layers.length || entryActive) {
    // Close open modals and reuse their history entry for the new page, so
    // Back from the new page returns to the page the modal was opened on.
    while (layers.length) layers.pop()!.close();
    entryActive = false;
    history.replaceState(null, "", to);
    path = location.pathname;
    emit();
    scrollToTarget(to);
    return;
  }
  if (to === location.pathname + location.search + location.hash && !replace) return;
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  path = location.pathname;
  emit();
  scrollToTarget(to);
}

export function useRoute() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => path,
    () => "/",
  );
}

/** The address's query, for the few screens an address parameter opens (a sign-in link). */
export function useSearch() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => location.search,
    () => "",
  );
}

// Registers an open modal layer. Returns a function that closes it. `url` is the modal's own
// address, shown while it is the bottom modal.
export function useModalLayer(onClose: () => void, url?: string) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const idRef = useRef(0);
  // Registered before the browser paints, so an Escape pressed as soon as the modal shows closes it.
  useLayoutEffect(() => {
    const id = ++serial;
    idRef.current = id;
    layers.push({ id, close: () => closeRef.current(), url });
    ensureEntry(url);
    return () => {
      const index = layers.findIndex((layer) => layer.id === id);
      if (index >= 0) {
        // Closed without Back (for example the parent unmounted).
        layers.splice(index, 1);
        if (!layers.length) scheduleDrop();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a layer registers once, when it mounts.
  }, []);
  return () => closeFrom(layers.findIndex((layer) => layer.id === idRef.current));
}

// Closes the layer at index and everything above it right away. Doing the
// bookkeeping synchronously means quick repeated Escape presses always target
// the modal that is still visible.
function closeFrom(index: number) {
  if (index < 0) return;
  const closing = layers.splice(index);
  for (let i = closing.length - 1; i >= 0; i--) closing[i].close();
  if (!layers.length) scheduleDrop();
}

if (typeof window !== "undefined") {
  // One Escape handler for every modal, wherever focus is. Popovers and menus
  // handle Escape first (capture phase) and mark the event as handled.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !layers.length) return;
    event.preventDefault();
    closeFrom(layers.length - 1);
  });
  // A media player's built-in controls keep Escape to themselves in some browsers, so the window
  // never hears it; catch it on the way down instead.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || !layers.length) return;
      if (!(event.target instanceof Element) || !event.target.matches("audio,video")) return;
      event.preventDefault();
      closeFrom(layers.length - 1);
    },
    true,
  );
}
