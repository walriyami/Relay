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
export async function openSink(small = false): Promise<Sink> {
  const dir = small ? null : await onDisk();
  if (dir) {
    try {
      return await diskSink(dir, `${++serial}`);
    } catch {
      // Out of room for even an empty file, or storage went away: memory still works.
    }
  }
  return memorySink();
}

async function diskSink(dir: FileSystemDirectoryHandle, name: string): Promise<Sink> {
  const handle = await dir.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  let written = 0;
  let crc = 0;
  let closed = false;
  return {
    get written() {
      return written;
    },
    get crc() {
      return crc;
    },
    async write(bytes) {
      await stream.write(bytes as Uint8Array<ArrayBuffer>);
      written += bytes.byteLength;
      crc = crc32(bytes, crc);
    },
    async finish(type, fileName, modified) {
      closed = true;
      await stream.close();
      const file = await handle.getFile();
      // The stored file under the name it was sent with; its bytes stay on disk.
      return new File([file], fileName, { type, lastModified: modified });
    },
    async discard() {
      if (!closed) await stream.abort().catch(() => {});
      closed = true;
      await dir.removeEntry(name).catch(() => {});
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

/** Most a browser without the private file system is trusted to hold in memory at once. */
const MEMORY_BYTES = 2 * 1024 ** 3;

/** Whether `bytes` more can be stored here, as far as the browser says. */
export async function roomFor(bytes: number) {
  if (!(await onDisk())) return bytes <= MEMORY_BYTES;
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota === undefined || usage === undefined) return true;
    return quota - usage > bytes;
  } catch {
    return true;
  }
}
