import type * as Tus from "tus-js-client";
import type { DetailedError, Upload } from "tus-js-client";
import { headers } from "../../shared/api";
import { uuidv7 } from "../../shared/ids";
import {
  ApiError,
  api,
  call,
  csrfToken,
  setCsrf,
  stableId,
  tab,
  urls,
  writeHeaders,
  type Delivery,
  type Link,
  type Prefs,
} from "../api";
import { autoName, copyText, shareUrl } from "./format";
import { isOnline, isProxyFailure, onConnectivity, reportFailure, whenOnline, whenSettled } from "./connection";
import { notifyChange, watchBeats } from "./live";
import { pathKey } from "./path-key";

// Transfers live only in this tab. Nothing uploads until the user picks a destination, and closing
// or reloading the tab abandons unfinished work on purpose.

export type DraftFile = { file: File; path: string };
export type Destination =
  | { kind: "save" }
  | ({ kind: "link" } & LinkOptions)
  | { kind: "device"; device: string; name: string }
  | { kind: "guest" };
/** A new link's options; `password` is sent once and dropped once the link exists. */
export type LinkOptions = {
  days: number | null;
  password?: string | null;
  visitorLimit?: number | null;
  note?: string;
};
type TaskStatus = "queued" | "uploading" | "done" | "failed" | "skipped";
type FileTask = {
  /** Position in the transfer, so the queue cursor can move back when a task is queued again. */
  index: number;
  file: File;
  path: string;
  uploadId?: string;
  sent: number;
  status: TaskStatus;
  error?: string;
  /** Failed for want of a connection or a working server, so coming back online retries it. */
  retryable?: boolean;
  upload?: Upload;
};
/**
 * `destination`: every file is saved but the destination step (link, delivery) failed. The server
 * transfer stays open, so the same transfer can be retried or completed to another destination.
 */
export type TransferStatus =
  | "preparing"
  | "uploading"
  | "paused"
  | "finishing"
  | "attention"
  | "destination"
  | "done"
  | "cancelling"
  | "cancelled"
  | "failed";
export type Transfer = {
  id: string;
  tabId: string;
  /**
   * What the transfer is called: the typed name, or the one the server derives from the contents,
   * built from the whole selection up front so it never changes while files arrive.
   */
  name: string;
  autoNamed: boolean;
  /** Top-level files and folders, as the item will hold them. */
  parts: { files: number; folders: number };
  destination: Destination;
  /** The upload request token when a guest sends this. */
  guest?: string;
  /** Set once the server has created the transfer. */
  itemId?: string;
  /**
   * Adds files to an existing item (the one `itemId` becomes), whose name and earlier contents
   * stay as they are. Cancelling keeps the item; only this transfer's unfinished files go.
   */
  adding?: boolean;
  text: string;
  folders: string[];
  tasks: FileTask[];
  status: TransferStatus;
  error?: string;
  started: number;
  totalBytes: number;
  sentBytes: number;
  doneFiles: number;
  failedFiles: number;
  speed: number;
  link?: Link;
  delivery?: Delivery;
  copied?: boolean;
  cancelled?: { saved: number; removed: boolean; deleting?: boolean };
  firstError?: string;
  cancelRequested?: boolean;
  /** An upload is retrying after a network or server error. */
  stalled?: boolean;
  /**
   * The status the server refused to create it with (413 over the quota or a limit, 507 out of
   * space), so the same request can only fail again.
   */
  rejected?: 413 | 507;
};

const CHUNK = 8 * 1024 ** 2;
const LARGE = 64 * 1024 ** 2;
const PARALLEL = 4;
const PARALLEL_LARGE = 2;
// Statuses that mean the request itself is wrong; retrying the same bytes cannot help.
const FINAL_STATUSES = new Set([400, 401, 403, 404, 409, 410, 412, 413, 415, 422, 507]);
const RETRY_DELAYS = [1000, 3000, 8000];

export const transfers: Transfer[] = [];
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Per transfer, the last rate sample and a smoothed rate that carries over a pause or reconnect. */
const meters = new Map<string, { at: number; bytes: number; rate: number }>();
const running = new Map<string, Set<FileTask>>();
/** Per transfer, the index of the first task that may still be queued. */
const cursors = new Map<string, number>();
/** The account preferences uploads follow. */
type SendPrefs = Pick<Prefs, "autoCopyLink" | "linkDays">;
let prefs: SendPrefs = { autoCopyLink: true, linkDays: 7 };
let grantCsrf = "";
const pendingCreates = new Map<string, StartInput>();
const sessionChecks = new WeakMap<Transfer, Promise<unknown>>();

/** The signed-in member's preferences that shape finishing: auto-copy and the default link expiry. */
export function setTransferPrefs(value: SendPrefs) {
  prefs = value;
}
export const defaultLinkDays = () => prefs.linkDays;
export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export const snapshot = () => version;

/** Unfinished work the server holds for this tab; closing the tab abandons it. */
export const isBusy = (t: Transfer) =>
  ["preparing", "uploading", "paused", "finishing", "attention", "destination", "cancelling"].includes(t.status) ||
  pendingCreates.has(t.id) ||
  (t.status === "failed" && !!t.cancelRequested);
const stopped = (t: Transfer) => t.status === "cancelling" || t.status === "cancelled";

function summarize(t: Transfer) {
  let sent = 0;
  let done = 0;
  let failed = 0;
  for (const task of t.tasks) {
    if (task.status === "done") {
      sent += task.file.size;
      done++;
    } else {
      sent += Math.min(task.sent, task.file.size);
      if (task.status === "failed") failed++;
    }
  }
  t.sentBytes = sent;
  t.doneFiles = done;
  t.failedFiles = failed;
  const moving = t.status === "uploading" && isOnline() && !t.stalled;
  const now = performance.now();
  const meter = meters.get(t.id) ?? { at: 0, bytes: 0, rate: 0 };
  meters.set(t.id, meter);
  // Time spent paused or waiting is not measured, and a resumed upload restarts from the server's
  // offset, so either starts a new sample instead of dragging the rate down.
  if (!moving || !meter.at || sent < meter.bytes) {
    meter.at = moving ? now : 0;
    meter.bytes = sent;
  } else if (now - meter.at >= 1000) {
    const rate = ((sent - meter.bytes) * 1000) / (now - meter.at);
    meter.rate = meter.rate ? meter.rate * 0.7 + rate * 0.3 : rate;
    meter.at = now;
    meter.bytes = sent;
  }
  t.speed = moving ? meter.rate : 0;
}
function changed(immediate = false) {
  const flush = () => {
    timer = undefined;
    for (const t of transfers) summarize(t);
    version++;
    syncGuestStreams();
    listeners.forEach((fn) => fn());
  };
  if (immediate) {
    clearTimeout(timer);
    flush();
  } else if (!timer) timer = setTimeout(flush, 100);
}

/**
 * Retries a call whose failure may be the network or a lost response; every one here is idempotent.
 * While Relay can't be reached (offline, or Relay down) it waits for it without using up its retries.
 */
async function persist<T>(t: Transfer, work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ;) {
    try {
      if (!transfers.includes(t) || t.tabId !== tab()) throw new ApiError(410, "This transfer’s tab session ended.");
      return await work();
    } catch (error) {
      const transient =
        !(error instanceof ApiError) || error.status >= 500 || error.status < 400 || error.status === 429;
      if (!transient) throw error;
      // A failure the connection explains waits for it to come back instead of using up retries.
      await whenSettled();
      if (!isOnline()) {
        await whenOnline();
        continue;
      }
      if (attempt >= RETRY_DELAYS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt++]));
    }
  }
}

// Two picks can share a name (the same file name from different places); the server needs unique paths.
export function uniquePaths(files: DraftFile[]) {
  const used = new Set<string>();
  return files.map(({ file, path }) => {
    let next = path;
    for (let n = 2; used.has(pathKey(next)); n++) {
      const slash = path.lastIndexOf("/");
      const dot = path.lastIndexOf(".");
      const split = dot > slash + 1 ? dot : path.length;
      next = `${path.slice(0, split)} (${n})${path.slice(split)}`;
    }
    used.add(pathKey(next));
    return { file, path: next };
  });
}

/** The top-level entries the server creates, in its order: files as requested, then folders. */
function topLevel(files: { path: string }[], folders: string[]) {
  const seen = new Map<string, { name: string; folder: boolean }>();
  const add = (path: string, folder: boolean) => {
    const slash = path.indexOf("/");
    const name = (slash < 0 ? path : path.slice(0, slash)).normalize("NFC");
    // Names compare the way the server's NOCASE index does: ASCII letters only.
    const key = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (!seen.has(key)) seen.set(key, { name, folder: folder || slash >= 0 });
  };
  files.forEach((f) => add(f.path, false));
  folders.forEach((f) => add(f, true));
  return [...seen.values()];
}
/** The name the server gives an item nobody named ("a.png + 2 more + text"), before anything is sent. */
export const contentName = (files: DraftFile[], folders: string[], text: string) =>
  autoName(topLevel(uniquePaths(files), folders), text);

/** Counts what the transfer will hold and, unless it was named, names it the way the server will. */
function describe(t: Transfer) {
  const top = topLevel(
    t.tasks.filter((task) => task.status !== "skipped"),
    t.folders,
  );
  t.parts = { files: top.filter((e) => !e.folder).length, folders: top.filter((e) => e.folder).length };
  if (t.autoNamed) t.name = autoName(top, t.text);
}

const encoder = new TextEncoder();
/** What a transfer counts against the storage quota: its files plus its text. */
export const payloadBytes = (fileBytes: number, text: string) =>
  fileBytes + (text.trim() ? encoder.encode(text).length : 0);
/** Bytes already uploaded for files that haven't finished; cancelling discards them. */
export const unsavedBytes = (t: Transfer) =>
  t.tasks.reduce((n, task) => (task.status === "done" ? n : n + Math.min(task.sent, task.file.size)), 0);
/** The unfinished transfer in this tab that is filling a library item, if any. */
export const transferFor = (itemId: string) => transfers.find((t) => t.itemId === itemId && isBusy(t));

export type StartInput = {
  files: DraftFile[];
  folders: string[];
  text: string;
  /** The typed name; null lets the server name it from the contents. */
  name: string | null;
  /** Adds the files to this existing item instead; `name` and `retentionDays` are then unused. */
  item?: string;
  destination: Destination;
  /** Omitted keeps the account default; null keeps it forever. */
  retentionDays?: number | null;
  guest?: string;
  /** The name a guest gave, sent with a request submission. */
  sender?: string;
};

export function startTransfer(input: StartInput) {
  const files = uniquePaths(input.files);
  const t: Transfer = {
    id: uuidv7(),
    tabId: tab(),
    name: input.name ?? "",
    autoNamed: input.name === null,
    parts: { files: 0, folders: 0 },
    destination: input.destination,
    guest: input.guest,
    ...(input.item ? { adding: true } : {}),
    text: input.text,
    folders: input.folders,
    tasks: files.map((f, index) => ({ ...f, index, sent: 0, status: "queued" })),
    status: "preparing",
    started: Date.now(),
    totalBytes: files.reduce((n, f) => n + f.file.size, 0),
    sentBytes: 0,
    doneFiles: 0,
    failedFiles: 0,
    speed: 0,
  };
  describe(t);
  pendingCreates.set(t.id, input);
  transfers.unshift(t);
  changed(true);
  void prepare(t, input);
  return t;
}

async function createTransfer(t: Transfer, input: StartInput) {
  const files = input.files.length
    ? uniquePaths(input.files).map((task) => ({
        path: task.path,
        size: task.file.size,
        mime: task.file.type.slice(0, 120),
      }))
    : [];
  if (t.guest) {
    const token = t.guest;
    const grant = await persist(t, () => call(api.requests.start, { params: { token } }));
    if (!transfers.includes(t) || t.tabId !== tab()) throw new ApiError(410, "This transfer’s tab session ended.");
    // A re-issued grant has a new CSRF token; a member session's token is never replaced.
    if (!csrfToken() || csrfToken() === grantCsrf) setCsrf((grantCsrf = grant.csrf));
    return persist(t, () =>
      call(api.requests.transfer, {
        params: { token },
        body: {
          id: t.id,
          tab: t.tabId,
          folders: input.folders,
          files,
          ...(input.sender ? { sender: input.sender } : {}),
        },
      }),
    );
  }
  return persist(t, () =>
    call(api.transfers.create, {
      body: {
        id: t.id,
        tab: t.tabId,
        name: input.name,
        ...(input.item ? { item: input.item } : {}),
        ...(input.retentionDays !== undefined ? { retentionDays: input.retentionDays } : {}),
        ...(t.text.trim() ? { text: t.text } : {}),
        folders: input.folders,
        files,
      },
    }),
  );
}

async function prepare(t: Transfer, input: StartInput) {
  try {
    const created = await createTransfer(t, input);
    if (!transfers.includes(t) || t.tabId !== tab()) return;
    t.itemId = created.itemId;
    pendingCreates.delete(t.id);
    created.uploads.forEach((upload, i) => {
      const task = t.tasks[i];
      task.uploadId = upload.id;
      task.path = upload.path;
      // Empty files are complete as soon as the transfer exists.
      if (!task.file.size) task.status = "done";
    });
    if (stopped(t)) return finishCancel(t);
    t.status = "uploading";
    changed(true);
    settle(t);
  } catch (error) {
    if (stopped(t)) return finishCancel(t);
    t.error = (error as Error).message || "Could not start the transfer.";
    if (error instanceof ApiError && (error.status === 413 || error.status === 507)) {
      // Over the quota, the file size limit or the server's space: nothing was created, and the
      // same request can only be refused again.
      t.rejected = error.status;
      pendingCreates.delete(t.id);
    }
    // Otherwise keep the exact manifest and id: retry recovers even a lost successful response.
    t.status = "failed";
    changed(true);
  }
}

export const canRetryCreate = (t: Transfer) => t.status === "failed" && pendingCreates.has(t.id) && !t.cancelRequested;
export function retryCreate(t: Transfer) {
  const input = pendingCreates.get(t.id);
  if (!input || !canRetryCreate(t)) return;
  t.status = "preparing";
  t.error = undefined;
  changed(true);
  void prepare(t, input);
}

/** Marks a task queued again and moves the cursor back to it. */
function requeue(t: Transfer, task: FileTask) {
  task.status = "queued";
  cursors.set(t.id, Math.min(cursors.get(t.id) ?? 0, task.index));
}

/** Starts queued tasks up to the parallel limits. Returns whether any task is still queued. */
function pump(t: Transfer): boolean {
  const active = running.get(t.id) || new Set<FileTask>();
  running.set(t.id, active);
  let large = [...active].filter((task) => task.file.size > LARGE).length;
  // Tasks before the cursor are never queued, so a 10,000-file transfer is not rescanned per file.
  let cursor = cursors.get(t.id) ?? 0;
  while (cursor < t.tasks.length && t.tasks[cursor].status !== "queued") cursor++;
  cursors.set(t.id, cursor);
  let waiting = false;
  // Offline, nothing starts: the queue waits for the connection instead of failing.
  for (let i = cursor; i < t.tasks.length && active.size < PARALLEL && isOnline(); i++) {
    const task = t.tasks[i];
    if (task.status !== "queued") continue;
    if (task.file.size > LARGE) {
      if (large >= PARALLEL_LARGE) {
        waiting = true;
        continue;
      }
      large++;
    }
    active.add(task);
    task.status = "uploading";
    void runTask(t, task).finally(() => {
      active.delete(task);
      settle(t);
    });
  }
  if (waiting) return true;
  for (let i = cursors.get(t.id)!; i < t.tasks.length; i++) if (t.tasks[i].status === "queued") return true;
  return false;
}

function settle(t: Transfer) {
  changed();
  if (t.status !== "uploading") return;
  if (pump(t)) return;
  if (running.get(t.id)?.size) return;
  if (t.tasks.some((task) => task.status === "failed")) {
    t.status = "attention";
    t.firstError = t.tasks.find((task) => task.status === "failed")?.error;
    changed(true);
    return;
  }
  void finalize(t);
}

function uploadMessage(error: unknown) {
  const response = (error as DetailedError).originalResponse;
  try {
    const message = response && (JSON.parse(response.getBody()) as { error?: string }).error;
    if (message) return message;
  } catch {
    // tus errors do not always carry a JSON body.
  }
  return "The connection was interrupted.";
}

// The tus client is fetched right after startup, off the first render's critical path. A failed
// fetch (for example while offline) is retried when the next upload needs it.
let tusModule: Promise<typeof Tus> | null = null;
const loadTus = () =>
  (tusModule ??= import("tus-js-client").catch((error) => {
    tusModule = null;
    throw error;
  }));
if (typeof window !== "undefined") setTimeout(() => void loadTus().catch(() => {}), 0);

async function runTask(t: Transfer, task: FileTask) {
  let aborted = false;
  // What the server has confirmed. Bytes of a request that is cut short (pause, going offline)
  // are sent again, so progress falls back to this at once rather than going down on resume.
  let accepted = task.sent;
  try {
    const { Upload } = await loadTus();
    await new Promise<void>((resolve, reject) => {
      const upload = new Upload(task.file, {
        uploadUrl: location.origin + urls.upload(task.uploadId!),
        headers: writeHeaders(),
        chunkSize: CHUNK,
        retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
        storeFingerprintForResuming: false,
        onShouldRetry: (error) => {
          const response = error.originalResponse;
          const status = response?.getStatus() ?? 0;
          if (!status || isProxyFailure(status)) reportFailure();
          // While Relay can't be reached, the task goes back to the queue and continues when it can.
          if (!isOnline()) return false;
          if (response?.getStatus() === 409 && response.getHeader("Upload-Offset") !== null) return true;
          if (FINAL_STATUSES.has(response?.getStatus() ?? 0)) return false;
          t.stalled = true;
          changed();
          return true;
        },
        onProgress: (sent) => {
          task.sent = sent;
          t.stalled = false;
          changed();
        },
        onChunkComplete: (_chunk, bytesAccepted) => {
          accepted = bytesAccepted;
        },
        onError: reject,
        onSuccess: () => resolve(),
      });
      task.upload = upload;
      const abort = upload.abort.bind(upload);
      upload.abort = (terminate) => {
        aborted = true;
        task.sent = Math.min(task.sent, accepted);
        resolve();
        return abort(terminate);
      };
      upload.start();
    });
    task.upload = undefined;
    if (aborted) {
      if (task.status === "uploading") requeue(t, task);
      return;
    }
    // The final PATCH completed the file on the server.
    task.sent = task.file.size;
    task.status = "done";
  } catch (error) {
    task.upload = undefined;
    const status = (error as DetailedError).originalResponse?.getStatus();
    if (!status || isProxyFailure(status)) {
      reportFailure();
      await whenSettled();
    }
    if (stopped(t) || t.status === "paused" || ((!status || isProxyFailure(status)) && !isOnline())) {
      if (task.status === "uploading") requeue(t, task);
      return;
    }
    if (status === 401) window.dispatchEvent(new Event("relay-session-expired"));
    else if (status === 404 && !t.guest) {
      // Distinguish a missing upload from an expired member session once, without retrying bytes.
      if (!sessionChecks.has(t))
        sessionChecks.set(
          t,
          call(api.session.get).catch(() => {}),
        );
      await sessionChecks.get(t);
    }
    if (stopped(t) || !transfers.includes(t)) return;
    task.error = uploadMessage(error);
    task.retryable = !status || status >= 500 || status === 429;
    task.status = "failed";
  }
}

const serverDestination = (d: Destination) =>
  d.kind === "device" ? { kind: d.kind, device: d.device } : d.kind === "link" ? d : { kind: "save" as const };

async function finalize(t: Transfer) {
  t.status = "finishing";
  t.error = undefined;
  changed(true);
  try {
    const result = await persist(t, () =>
      call(api.transfers.complete, { params: { id: t.id }, body: { destination: serverDestination(t.destination) } }),
    );
    t.link = result.link ?? undefined;
    // The link exists; its password needn't stay in memory.
    if (t.destination.kind === "link" && t.destination.password)
      t.destination = { ...t.destination, password: undefined };
    t.delivery = result.delivery ?? undefined;
    if (t.link && prefs.autoCopyLink) t.copied = await copyText(shareUrl(t.link.token)).catch(() => false);
    t.status = "done";
    t.cancelRequested = false;
  } catch (error) {
    if (stopped(t)) return;
    t.error = (error as Error).message;
    // 410: the server no longer holds the transfer (cancelled or its tab lease ended). Otherwise
    // every file is saved and the transfer stays open for another attempt or destination.
    t.status = error instanceof ApiError && error.status === 410 ? "failed" : "destination";
    // A device that went offline must leave the destination list.
    if (t.destination.kind === "device") notifyChange("devices");
  }
  changed(true);
  if (!t.guest) {
    notifyChange("items");
    if (t.link) notifyChange("links");
    if (t.delivery) notifyChange("deliveries");
  }
}

/** Shares a transfer that was saved or sent: the drop box then shows the link like any link result. */
export async function addLink(t: Transfer, options: LinkOptions) {
  if (t.status !== "done" || !t.itemId || t.link) return;
  const key = stableId(`link:${t.itemId}`);
  const link = await call(api.links.create, { body: { id: key.id, item: t.itemId, ...options } });
  key.forget();
  t.link = link;
  if (prefs.autoCopyLink) t.copied = await copyText(shareUrl(link.token)).catch(() => false);
  changed(true);
  notifyChange("links");
  notifyChange("items");
}

/** Tries the destination step again, or completes the saved files to another destination. */
export function retarget(t: Transfer, destination: Destination = t.destination) {
  if (t.status !== "destination") return;
  t.destination = destination;
  void finalize(t);
}

/** Every file is saved and only the destination is left undecided; Done settles it as saved. */
export const awaitsChoice = (t: Transfer) => t.status === "destination";

export async function keepInFiles(t: Transfer) {
  if (t.status !== "destination") return;
  t.destination = { kind: "save" };
  await finalize(t);
  // finalize changes the status; read it afresh.
  if ((t.status as Transfer["status"]) === "done") dismiss(t);
}

export function retryFailed(t: Transfer) {
  if (t.status !== "attention") return;
  for (const task of t.tasks)
    if (task.status === "failed") {
      requeue(t, task);
      task.error = undefined;
      task.retryable = undefined;
    }
  t.status = "uploading";
  t.firstError = undefined;
  changed(true);
  pump(t);
}

export async function skipFailed(t: Transfer) {
  if (t.status !== "attention") return;
  t.status = "finishing";
  changed(true);
  try {
    for (const task of t.tasks.filter((x) => x.status === "failed")) {
      await persist(t, () => call(api.transfers.removeUpload, { params: { id: task.uploadId! } }));
      task.status = "skipped";
      if (stopped(t)) return;
    }
  } catch (error) {
    if (stopped(t)) return;
    t.status = "attention";
    t.firstError = (error as Error).message;
    changed(true);
    return;
  }
  if (!t.tasks.some((task) => task.status === "done") && !t.text.trim()) {
    t.status = "cancelling";
    changed(true);
    return finishCancel(t);
  }
  // The item holds only what arrived, and an automatic name says so.
  describe(t);
  await finalize(t);
}

function abortUploads(t: Transfer) {
  for (const task of running.get(t.id) || []) void task.upload?.abort(false);
}

export function pause(t: Transfer) {
  if (t.status !== "uploading") return;
  t.status = "paused";
  t.stalled = false;
  abortUploads(t);
  changed(true);
}
export function resume(t: Transfer) {
  if (t.status !== "paused") return;
  t.status = "uploading";
  changed(true);
  // The last file may have finished while paused; settling then moves on to finishing.
  settle(t);
}

async function finishCancel(t: Transfer) {
  if (t.status === "cancelled") return;
  abortUploads(t);
  try {
    t.cancelled = await persist(t, () => call(api.transfers.cancel, { params: { id: t.id } }));
    const input = pendingCreates.get(t.id);
    if (!t.cancelled.removed && !t.itemId && input) {
      // The create response was lost, but cancellation proved this id exists. Its
      // idempotent create response supplies the retained item's identity for View/Delete.
      t.itemId = (await createTransfer(t, input)).itemId;
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      // Completion won the race. Its idempotent endpoint recovers the actual result.
      return finalize(t);
    }
    if (error instanceof ApiError && error.status === 404 && !t.itemId) {
      t.cancelled = { saved: 0, removed: true };
    } else {
      t.status = "failed";
      t.error = "Could not confirm cancellation. Retry to release the unfinished upload.";
      changed(true);
      return;
    }
  }
  pendingCreates.delete(t.id);
  t.status = "cancelled";
  changed(true);
  if (!t.guest) notifyChange("items");
}

export function cancel(t: Transfer) {
  if (!["preparing", "uploading", "paused", "attention", "finishing", "destination", "failed"].includes(t.status))
    return;
  t.cancelRequested = true;
  const preparing = t.status === "preparing";
  t.status = "cancelling";
  abortUploads(t);
  changed(true);
  // While preparing, prepare() notices the flag and finishes the cancel itself.
  if (!preparing) void finishCancel(t);
}

export async function deleteSaved(t: Transfer) {
  const itemId = t.itemId;
  if (!itemId || !t.cancelled || t.guest || t.adding) return;
  t.cancelled.deleting = true;
  changed(true);
  try {
    await call(api.items.trash, { params: { id: itemId } });
    await call(api.items.remove, { params: { id: itemId } });
    t.cancelled = { saved: 0, removed: true };
  } catch (error) {
    t.cancelled.deleting = false;
    t.error = (error as Error).message;
  }
  changed(true);
  notifyChange("items");
}

export function dismiss(t: Transfer) {
  if (!["done", "cancelled", "failed"].includes(t.status)) return;
  if (pendingCreates.has(t.id) || (t.cancelRequested && t.status === "failed")) {
    cancel(t);
    return;
  }
  const index = transfers.indexOf(t);
  if (index >= 0) transfers.splice(index, 1);
  meters.delete(t.id);
  running.delete(t.id);
  cursors.delete(t.id);
  changed(true);
}

// Losing Relay (offline, or Relay down) stops the uploads at once instead of letting them stall, and
// reaching it again continues them from what the server holds. Neither uses up an upload's retries.
onConnectivity(() => {
  for (const t of transfers)
    if (!isOnline()) {
      if (t.status === "uploading") {
        t.stalled = false;
        abortUploads(t);
      }
    } else if (t.status === "uploading") settle(t);
    else if (t.status === "attention" && t.tasks.every((task) => task.status !== "failed" || task.retryable))
      retryFailed(t);
  changed(true);
});

/** Signing out stops everything this tab was doing. */
export async function abandonAll() {
  const oldTab = tab();
  const hadOpen = transfers.some(isBusy);
  abandoned = null;
  for (const t of transfers) {
    if (isBusy(t) || pendingCreates.has(t.id)) {
      t.status = "cancelled";
      abortUploads(t);
    }
  }
  pendingCreates.clear();
  transfers.splice(0);
  changed(true);
  // Closing the lease also rejects creates that were in flight when the principal changed.
  if (!hadOpen) return;
  await fetch(closeTabUrl(oldTab), {
    method: "POST",
    credentials: "same-origin",
    headers: writeHeaders(),
  }).catch(() => {});
}

// Guests have no member event stream, so their page holds this one open to keep the tab's lease.
const guestStreams = new Map<string, () => void>();
function guestStream(token: string) {
  let source: EventSource;
  let unwatch = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  let closed = false;
  const connect = () => {
    if (closed) return;
    const current = new EventSource(urls.guestEvents(token, tab()));
    source = current;
    current.addEventListener("ready", () => {
      if (!closed && source === current) delay = 1000;
    });
    const retry = () => {
      if (closed || source !== current || timer) return;
      unwatch();
      current.close();
      timer = setTimeout(() => {
        timer = undefined;
        connect();
      }, delay);
      delay = Math.min(delay * 2, 30000);
    };
    // A stream cut without closing would otherwise stop renewing the lease without anyone noticing.
    unwatch = watchBeats(current, retry);
    current.addEventListener("error", () => {
      if (current.readyState === EventSource.CLOSED) retry();
    });
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    unwatch();
    source.close();
  };
}
function syncGuestStreams() {
  const needed = new Set(transfers.filter((t) => t.guest && t.itemId && isBusy(t)).map((t) => t.guest!));
  for (const [token, close] of guestStreams)
    if (!needed.has(token)) {
      close();
      guestStreams.delete(token);
    }
  for (const token of needed) if (!guestStreams.has(token)) guestStreams.set(token, guestStream(token));
}

const closeTabUrl = (id: string) => api.transfers.closeTab.path.replace(":id", id);

// A reload keeps sessionStorage, so the next page load closes this tab too when the browser dropped
// the pagehide request. A closed tab without that falls back to the lease running out.
const OPEN_TAB = "relay.open-tab";
let remembered = "";
function rememberTab() {
  const value = transfers.some(isBusy) ? JSON.stringify({ tab: tab(), csrf: csrfToken() }) : "";
  if (value === remembered) return;
  remembered = value;
  try {
    if (value) sessionStorage.setItem(OPEN_TAB, value);
    else sessionStorage.removeItem(OPEN_TAB);
  } catch {
    // Without storage the lease still expires.
  }
}

// What leaving the page stopped, so the next load of this tab can say so instead of showing an empty
// drop box. `itemId` is set when finished files or text were kept in Files.
export type AbandonedUpload = { name: string; itemId?: string };
const ABANDONED = "relay.abandoned";
let abandoned: { uploads: AbandonedUpload[]; reloaded: boolean } | null = null;
export const abandonedUploads = () => abandoned;
export function forgetAbandoned() {
  if (!abandoned) return;
  abandoned = null;
  changed(true);
}
function rememberAbandoned() {
  const uploads: AbandonedUpload[] = transfers
    .filter((t) => !t.guest && isBusy(t) && !stopped(t) && !t.cancelRequested)
    .map((t) => ({
      name: t.name,
      ...(t.itemId && (t.tasks.some((task) => task.status === "done") || t.text.trim()) ? { itemId: t.itemId } : {}),
    }));
  try {
    if (uploads.length) sessionStorage.setItem(ABANDONED, JSON.stringify(uploads));
  } catch {
    // The next load just won't mention it.
  }
}

if (typeof window !== "undefined") {
  try {
    const uploads = JSON.parse(sessionStorage.getItem(ABANDONED) || "[]") as AbandonedUpload[];
    sessionStorage.removeItem(ABANDONED);
    if (Array.isArray(uploads) && uploads.length) {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      abandoned = { uploads, reloaded: navigation?.type === "reload" };
    }
  } catch {
    // Nothing remembered.
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(OPEN_TAB) || "null") as { tab?: unknown; csrf?: unknown } | null;
    sessionStorage.removeItem(OPEN_TAB);
    if (saved && typeof saved.tab === "string" && saved.tab !== tab())
      void fetch(closeTabUrl(saved.tab), {
        method: "POST",
        credentials: "same-origin",
        headers: typeof saved.csrf === "string" && saved.csrf ? { [headers.csrf]: saved.csrf } : {},
      }).catch(() => {});
  } catch {
    // Nothing remembered.
  }
  window.addEventListener("beforeunload", (event) => {
    if (!transfers.some(isBusy)) return;
    event.preventDefault();
    // Older Safari and Chrome only warn when returnValue is set.
    event.returnValue = "";
  });
  // The old lease was closed on pagehide. Reloading a bfcache restore discards its stale
  // uploads and streams and obtains a fresh identity, just like an ordinary reload.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });
  // Leaving the page is deliberate: the server abandons this tab's unfinished uploads right away.
  window.addEventListener("pagehide", () => {
    rememberTab();
    rememberAbandoned();
    if (!transfers.some(isBusy)) return;
    void fetch(closeTabUrl(tab()), {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers: writeHeaders(),
    }).catch(() => {});
  });
}
