import { LIMITS } from "../../shared/model.ts";
import { addSelection, fromFileList, getDraft, setText } from "./draft";
import { navigate } from "./router";
import { canShare, downloadFile, share, touch } from "./nearby/save";

// "Share to Relay" from another app. The service worker (public/sw.js) keeps what was shared in this
// browser's IndexedDB and opens /share?id=<id>; the iOS Shortcut (README) opens /share#text=…&url=…
// instead (after "#" nothing reaches the server). Either way Relay first shows what arrived and adds
// it to the Send draft only when the person chooses Add: an outside website can submit the same form
// or open the same address, and nothing in the request reliably tells it apart from the share sheet.

type Shared = { id: string; created: number; title: string; text: string; url: string; files: File[] };
/** What arrived, waiting for Add or Discard. `id` is set when it came through the service worker. */
export type Incoming = { id?: string; files: File[]; text: string };
export type ShareResult = { files: number; text: boolean } | "missing";

const DB = "relay-share";
const STORE = "shares";
const DAY = 24 * 3600 * 1000;

function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("This browser’s storage isn’t available."));
  });
}
function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("This browser’s storage isn’t available."));
  });
}

/**
 * Finds one share in the browser's store and, with `remove`, takes it out. Shares left over from
 * more than a day ago are dropped either way.
 */
async function find(id: string, remove: boolean) {
  const db = await open();
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let found: Shared | undefined;
    const all = store.getAll();
    all.onsuccess = () => {
      for (const share of all.result as Shared[]) {
        const old = Date.now() - share.created > DAY;
        if (share.id === id && !old) found = share;
        if ((share.id === id && remove) || old) store.delete(share.id);
      }
    };
    await done(tx);
    return found;
  } finally {
    db.close();
  }
}

/**
 * When Relay starts: drops shares nobody added or discarded within a day (the person closed Relay
 * instead of choosing).
 */
export async function sweepShares() {
  if (typeof indexedDB === "undefined") return;
  await find("", false).catch(() => undefined);
}

/** On sign-out: nothing shared stays in this browser for the next person. */
export async function forgetShares() {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await open();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      await done(tx);
    } finally {
      db.close();
    }
  } catch {
    // No store yet.
  }
}

/** The text a share brings: its title, words and link, without repeating one inside another. */
export function sharedText(parts: { title?: string; text?: string; url?: string }) {
  const lines: string[] = [];
  for (const part of [parts.title, parts.text, parts.url]) {
    const value = part?.trim();
    if (value && !lines.some((line) => line.includes(value))) lines.push(value);
  }
  return lines.join("\n");
}

function addText(text: string) {
  if (!text) return false;
  const current = getDraft().text.trim();
  setText((current ? `${current}\n${text}` : text).slice(0, LIMITS.textBytes));
  return true;
}

/**
 * What was shared, for the address Relay opened on (/share…), without adding it anywhere yet.
 * "failed" when the browser couldn't keep it, "missing" when it was already added or discarded,
 * null when the address carries nothing.
 */
export async function readShare(
  location: Pick<Location, "search" | "hash">,
): Promise<Incoming | "failed" | "missing" | null> {
  const id = new URLSearchParams(location.search).get("id");
  if (id === "failed") return "failed";
  if (id) {
    const shared = await find(id, false).catch(() => undefined);
    if (!shared) return "missing";
    return { id, files: shared.files, text: sharedText(shared) };
  }
  if (location.hash.length > 1) {
    const params = new URLSearchParams(location.hash.slice(1));
    const text = sharedText({
      title: params.get("title") ?? "",
      text: params.get("text") ?? "",
      url: params.get("url") ?? "",
    });
    return text ? { files: [], text } : null;
  }
  return null;
}

/**
 * Adds what arrived to the Send draft (the person chose Add). A share the service worker kept is
 * taken out of the store first, so a second tab or a second tap can't add it twice.
 */
export async function addShare(incoming: Incoming): Promise<ShareResult> {
  let { files, text } = incoming;
  if (incoming.id) {
    const shared = await find(incoming.id, true);
    if (!shared) return "missing";
    files = shared.files;
    text = sharedText(shared);
  }
  if (files.length) addSelection(fromFileList(files));
  return { files: files.length, text: addText(text) };
}

/** Forgets what arrived without adding it (the person chose Discard). */
export async function discardShare(incoming: Incoming) {
  if (incoming.id) await find(incoming.id, true).catch(() => undefined);
}

/** Leaves /share for Send, without the shared details in the address or the history. */
export function leaveShare() {
  navigate("/", true);
}

/** Opens the share sheet for a link (phones and tablets). False when there is no share sheet. */
export async function shareLink(url: string, title?: string) {
  if (!canShareLink()) return false;
  try {
    await navigator.share(title ? { url, title } : { url });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) return false;
  }
  return true;
}
export const canShareLink = () => touch && typeof navigator !== "undefined" && typeof navigator.share === "function";

const photoOrVideo = (type: string) => type.startsWith("image/") || type.startsWith("video/");

/** Whether saving this file should offer the share sheet, where "Save Image"/"Save Video" live. */
export const savesToPhotos = (name: string, type: string) =>
  touch && photoOrVideo(type) && canShare([new File([], name, { type })]);

/**
 * Hands one photo or video to the share sheet so it can be saved to the photo library. Fetching
 * takes a moment, after which some browsers no longer count the tap: `retry` then asks for one more.
 */
export async function savePhoto(url: string, name: string, retry: (save: () => Promise<boolean>) => void) {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error("This file couldn’t be loaded.");
  const blob = await response.blob();
  const file = new File([blob], name, { type: blob.type });
  const attempt = async () => {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return true;
      if (error instanceof DOMException && error.name === "NotAllowedError") return false;
      downloadFile(file, name);
      return true;
    }
  };
  if (!(await attempt())) retry(() => share([file]));
}
