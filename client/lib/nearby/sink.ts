import { crc32 } from "./zip";

// Where received bytes go until they are saved. Browsers with the origin private file system write
// them to disk as they arrive, so a large transfer never has to fit in memory; others keep them in
// memory. Either way they belong to this tab: each tab writes in its own folder, held with a lock,
// and a tab starting up clears the folders no open tab holds.

const ROOT = "relay-nearby";
const LOCK = "relay-nearby-files:";

export interface Sink {
  /** Bytes stored so far. */
  readonly written: number;
  /** CRC-32 of the bytes stored so far. */
  readonly crc: number;
  write(bytes: Uint8Array): Promise<void>;
  /** The whole entry, once every byte is written. */
  finish(type: string, name: string, modified: number): Promise<File>;
  /** Frees what it holds, finished or not. */
  discard(): Promise<void>;
}

let folder: Promise<FileSystemDirectoryHandle | null> | undefined;
let serial = 0;

function onDisk(): Promise<FileSystemDirectoryHandle | null> {
  folder ??= (async () => {
    // Writing needs the private file system and a writable stream on its files (not every browser
    // has that outside workers), and the lock that keeps this tab's folder from being cleared.
    if (
      !navigator.storage?.getDirectory ||
      !navigator.locks ||
      typeof FileSystemFileHandle === "undefined" ||
      !("createWritable" in FileSystemFileHandle.prototype)
    )
      return null;
    try {
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle(ROOT, { create: true });
      const name = crypto.getRandomValues(new Uint32Array(2)).join("-");
      await hold(LOCK + name);
      const mine = await base.getDirectoryHandle(name, { create: true });
      void sweep(base, name);
      return mine;
    } catch {
      return null;
    }
  })();
  return folder;
}

/**
 * Holds `name` until the tab goes. WebKit won't load the tab's next page while it holds a lock, so
 * it's let go as the page goes, and taken again if the page comes back from the back-forward cache.
 */
function hold(name: string) {
  let release = () => {};
  const take = () =>
    new Promise<void>((held) => {
      void navigator.locks.request(name, () => {
        held();
        return new Promise<void>((done) => (release = done));
      });
    });
  window.addEventListener("pagehide", () => release());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void take();
  });
  return take();
}

/** Removes the folders of tabs that have gone. */
async function sweep(base: FileSystemDirectoryHandle, mine: string) {
  try {
    const held = new Set(((await navigator.locks.query()).held ?? []).map((lock) => lock.name));
    for await (const name of (base as unknown as { keys(): AsyncIterable<string> }).keys())
      if (name !== mine && !held.has(LOCK + name)) await base.removeEntry(name, { recursive: true }).catch(() => {});
  } catch {
    // Left for the next tab to clear.
  }
}

/** A new, empty entry; `small` ones (text) stay in memory. */
export async function openSink(small = false, allowMemory = () => true): Promise<Sink> {
  const dir = small ? null : await onDisk();
  if (dir) {
    try {
      return await diskSink(dir, `${++serial}`);
    } catch {
      // Storage went away: fallback must be admitted against the tab's retained payloads.
    }
  }
  if (!allowMemory()) throw new Error("There isn’t room in this tab for memory fallback.");
  return memorySink();
}

async function diskSink(dir: FileSystemDirectoryHandle, name: string): Promise<Sink> {
  const handle = await dir.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  let written = 0;
  let crc = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let discarded = false;
  let cleanup: Promise<void> | undefined;
  const stopped = () => new DOMException("The received file was discarded.", "AbortError");
  return {
    get written() {
      return written;
    },
    get crc() {
      return crc;
    },
    async write(bytes) {
      // Own exactly the view: some OPFS writers consume its whole backing buffer.
      await stream.write(new Uint8Array(bytes));
      written += bytes.byteLength;
      crc = crc32(bytes, crc);
    },
    async finish(type, fileName, modified) {
      if (discarded) throw stopped();
      closing ??= stream.close();
      await closing;
      closed = true;
      if (discarded) {
        await cleanup;
        throw stopped();
      }
      const file = await handle.getFile();
      if (discarded) {
        await cleanup;
        throw stopped();
      }
      // The stored file under the name it was sent with; its bytes stay on disk.
      return new File([file], fileName, { type, lastModified: modified });
    },
    discard() {
      discarded = true;
      // Own the stream and entry until a close already under way has settled. Removing an entry
      // while its writable stream still holds it can fail, leaving cancelled content on disk.
      cleanup ??= (async () => {
        await closing?.catch(() => {});
        if (!closed) await stream.abort().catch(() => {});
        closed = true;
        // Once more after a transient failure. A file that still won't go stays until this tab has
        // gone and the next one sweeps its folder.
        await dir.removeEntry(name).catch(() => dir.removeEntry(name).catch(() => {}));
      })();
      return cleanup;
    },
  };
}

/** Pieces are joined into blobs as they come, which some browsers keep on disk themselves. */
function memorySink(): Sink {
  const JOIN = 16 * 1024 * 1024;
  let blobs: Blob[] = [];
  let pending: Uint8Array<ArrayBuffer>[] = [];
  let pendingBytes = 0;
  let written = 0;
  let crc = 0;
  const join = () => {
    if (!pending.length) return;
    blobs.push(new Blob(pending));
    pending = [];
    pendingBytes = 0;
  };
  return {
    get written() {
      return written;
    },
    get crc() {
      return crc;
    },
    write(bytes) {
      pending.push(bytes as Uint8Array<ArrayBuffer>);
      pendingBytes += bytes.byteLength;
      written += bytes.byteLength;
      crc = crc32(bytes, crc);
      if (pendingBytes >= JOIN) join();
      return Promise.resolve();
    },
    finish(type, fileName, modified) {
      join();
      const file = new File(blobs, fileName, { type, lastModified: modified });
      blobs = [];
      return Promise.resolve(file);
    },
    discard() {
      blobs = [];
      pending = [];
      return Promise.resolve();
    },
  };
}

/**
 * Whether there is room for a transfer here. Without the private file system it is up to
 * `allowMemory`; with it, `allowDisk` is told how much the browser says is free (Infinity when it
 * won't say), and claims its share in the same call so transfers accepted together can't both count
 * the same space.
 */
export async function roomFor(allowMemory: () => boolean, allowDisk: (free: number) => boolean) {
  if (!(await onDisk())) return allowMemory();
  let free = Infinity;
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota !== undefined && usage !== undefined) free = quota - usage;
  } catch {
    // Unknown: writing finds out.
  }
  return allowDisk(free);
}
