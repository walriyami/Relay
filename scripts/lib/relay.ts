// Shared pieces of the release verification scripts: an HTTP session against a real Relay origin
// (cookies, CSRF, the typed contract), tus uploads, hashed downloads, a streaming ZIP reader,
// deterministic fixtures and disposable local server processes. Nothing here reads real data.
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { createWriteStream, openSync, closeSync, readSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { api, headers, urls, type Endpoint, type Input, type Response } from "../../shared/api.ts";
import { LIMITS, type Destination, type TransferCreated } from "../../shared/model.ts";

export const REPO = join(import.meta.dirname, "..", "..");
export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`${status} ${message}`);
    this.status = status;
  }
}

/** One browser-like client of a Relay origin: a cookie jar, its CSRF token and its tab id. */
export class Session {
  readonly origin: string;
  readonly cookies = new Map<string, string>();
  readonly tab = crypto.randomUUID().replaceAll("-", "");
  csrf = "";
  constructor(origin: string) {
    this.origin = origin.replace(/\/$/, "");
  }

  async fetch(path: string, init: RequestInit = {}): Promise<globalThis.Response> {
    const h = new Headers(init.headers);
    if (this.cookies.size) h.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const method = init.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      h.set("origin", this.origin);
      if (this.csrf) h.set(headers.csrf, this.csrf);
    }
    const res = await fetch(this.origin + path, { ...init, headers: h, redirect: "manual" });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  /** Calls a contract endpoint; throws HttpError with the server's message on failure. */
  async call<E extends Endpoint>(endpoint: E, input: Input<E> = {} as Input<E>): Promise<Response<E>> {
    const { params, query, body } = input as {
      params?: Record<string, string>;
      query?: Record<string, unknown>;
      body?: unknown;
    };
    let path: string = endpoint.path;
    for (const [key, value] of Object.entries(params ?? {})) path = path.replace(`:${key}`, encodeURIComponent(value));
    if (query) path += `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`;
    const res = await this.fetch(path, {
      method: endpoint.method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    const text = await res.text();
    const data = (text ? JSON.parse(text) : undefined) as { error?: string; csrf?: unknown } | undefined;
    if (!res.ok) throw new HttpError(res.status, data?.error ?? text);
    if (typeof data?.csrf === "string") this.csrf = data.csrf;
    return data as Response<E>;
  }

  signIn(username: string, password: string, deviceName: string) {
    return this.call(api.session.password, { body: { username, password, deviceName } });
  }
}

/** Expects `promise` to fail with `status`; returns the server's message. */
export async function rejects(promise: Promise<unknown>, status: number): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError && error.status === status) return error.message;
    throw error;
  }
  throw new Error(`Expected HTTP ${status}, but the request succeeded.`);
}

// ---- tus ----

export type Source = { size: number; read: (offset: number, length: number) => Buffer };
export const bufferSource = (data: Buffer): Source => ({
  size: data.length,
  read: (offset, length) => data.subarray(offset, offset + length),
});
export function fileSource(path: string, size: number): Source {
  return {
    size,
    read: (offset, length) => {
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.allocUnsafe(length);
        let done = 0;
        while (done < length) {
          const count = readSync(fd, buffer, done, length - done, offset + done);
          assert(count > 0, `Source ended at byte ${offset + done}.`);
          done += count;
        }
        return buffer;
      } finally {
        closeSync(fd);
      }
    },
  };
}

const tusHeaders = (offset: number) => ({
  "tus-resumable": "1.0.0",
  "upload-offset": String(offset),
  "content-type": "application/offset+octet-stream",
});

/** The committed offset of an upload (tus HEAD). */
export async function uploadOffset(session: Session, upload: string): Promise<number> {
  const res = await session.fetch(urls.upload(upload), {
    method: "HEAD",
    headers: { "tus-resumable": "1.0.0", [headers.tab]: session.tab },
  });
  if (res.status !== 200) throw new HttpError(res.status, "HEAD of the upload failed.");
  return Number(res.headers.get("upload-offset"));
}

/** One tus PATCH. Returns the status and the offset the server reports. */
export async function patch(
  session: Session,
  upload: string,
  offset: number,
  body: Buffer | ReadableStream,
  signal?: AbortSignal,
) {
  const res = await session.fetch(urls.upload(upload), {
    method: "PATCH",
    headers: { ...tusHeaders(offset), [headers.tab]: session.tab },
    body,
    signal,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
  const text = await res.text();
  return { status: res.status, offset: Number(res.headers.get("upload-offset") ?? NaN), text };
}

/**
 * Sends `data` at `offset` and then stalls without finishing the request, the way a connection
 * that dies mid-chunk looks to the server. `abort()` drops it.
 */
export function stalledPatch(session: Session, upload: string, offset: number, data: Buffer) {
  const controller = new AbortController();
  let sent!: () => void;
  const delivered = new Promise<void>((resolve) => (sent = resolve));
  const body = new ReadableStream({
    start(stream) {
      for (let at = 0; at < data.length; at += 1024 ** 2) stream.enqueue(data.subarray(at, at + 1024 ** 2));
      sent();
    },
  });
  const result = patch(session, upload, offset, body, controller.signal).then(
    (r) => r,
    (error: Error) => ({ status: 0, offset: NaN, text: error.message }),
  );
  return { delivered, result, abort: () => controller.abort() };
}

/** Uploads `source` from the server's committed offset to the end, chunk by chunk. */
export async function upload(
  session: Session,
  id: string,
  source: Source,
  options: { until?: number; onChunk?: (offset: number) => void } = {},
): Promise<number> {
  const until = options.until ?? source.size;
  let offset = await uploadOffset(session, id);
  while (offset < until) {
    const length = Math.min(LIMITS.chunkBytes, until - offset);
    const res = await patch(session, id, offset, source.read(offset, length));
    if (res.status !== 204) throw new HttpError(res.status, res.text);
    assert(res.offset === offset + length, "PATCH returned an incorrect offset.");
    offset = res.offset;
    options.onChunk?.(offset);
  }
  return offset;
}

/** Creates a transfer, uploads every file with `parallel` uploads at a time and completes it. */
export async function sendFiles(
  session: Session,
  files: { path: string; data: Buffer; mime?: string }[],
  options: {
    name?: string;
    text?: string;
    folders?: string[];
    destination?: Destination;
    parallel?: number;
    onCreated?: (transfer: TransferCreated) => void;
  } = {},
) {
  const created: TransferCreated = await session.call(api.transfers.create, {
    body: {
      id: crypto.randomUUID(),
      tab: session.tab,
      name: options.name ?? null,
      text: options.text,
      folders: options.folders ?? [],
      files: files.map((f) => ({ path: f.path, size: f.data.length, mime: f.mime ?? "application/octet-stream" })),
    },
  });
  options.onCreated?.(created);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      if (files[i].data.length) await upload(session, created.uploads[i].id, bufferSource(files[i].data));
    }
  };
  await Promise.all(Array.from({ length: options.parallel ?? 8 }, worker));
  const result = await session.call(api.transfers.complete, {
    params: { id: created.id },
    body: { destination: options.destination ?? { kind: "save" } },
  });
  return { created, result };
}

// ---- downloads ----

/** Streams a response body into a SHA-256 (and optionally a file); returns the digest and length. */
export async function consume(res: globalThis.Response, file?: string) {
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  assert(res.body, "The response has no body.");
  const source = Readable.fromWeb(res.body as never);
  // Without a file, the bytes are hashed and dropped, so memory stays bounded.
  const sink = file ? createWriteStream(file) : new Writable({ write: (_chunk, _encoding, callback) => callback() });
  await pipeline(source, meter, sink);
  return { sha256: hash.digest("hex"), bytes };
}

export async function download(session: Session, path: string, init: RequestInit = {}) {
  const res = await session.fetch(path, init);
  if (res.status !== 200 && res.status !== 206) throw new HttpError(res.status, await res.text());
  return { res, ...(await consume(res)) };
}

/**
 * Downloads `path`, drops the connection after roughly `fraction` of it, then resumes with a Range
 * request guarded by If-Range. Returns the digest of the joined bytes and the resume response.
 */
export async function resumedDownload(session: Session, path: string, fraction = 0.5) {
  const controller = new AbortController();
  const first = await session.fetch(path, { signal: controller.signal });
  if (first.status !== 200) throw new HttpError(first.status, await first.text());
  const total = Number(first.headers.get("content-length"));
  const etag = first.headers.get("etag")!;
  assert(Number.isSafeInteger(total) && total > 1 && etag, "Resume needs a length and ETag.");
  const cutoff = Math.max(1, Math.min(total - 1, Math.floor(total * fraction)));
  const hash = createHash("sha256");
  let got = 0;
  try {
    for await (const chunk of first.body as unknown as AsyncIterable<Uint8Array>) {
      const prefix = chunk.subarray(0, cutoff - got);
      hash.update(prefix);
      got += prefix.length;
      if (got === cutoff) {
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if ((error as Error).name !== "AbortError") throw error;
  }
  const rest = await session.fetch(path, { headers: { range: `bytes=${got}-`, "if-range": etag } });
  if (rest.status !== 206) throw new HttpError(rest.status, "The server did not resume the download with a range.");
  const range = rest.headers.get("content-range");
  if (range !== `bytes ${got}-${total - 1}/${total}`) throw new Error(`Unexpected Content-Range ${range}.`);
  for await (const chunk of rest.body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    got += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes: got, interruptedAt: cutoff, total };
}

// ---- ZIP ----

export type ZipFile = { path: string; folder: boolean; size: number; sha256: string };

/** Pulls exact byte counts out of an async stream of chunks. */
class Reader {
  private readonly source: AsyncIterator<Uint8Array>;
  private buffer = Buffer.alloc(0);
  offset = 0;
  constructor(stream: AsyncIterable<Uint8Array>) {
    this.source = stream[Symbol.asyncIterator]();
  }
  private async fill(n: number) {
    while (this.buffer.length < n) {
      const next = await this.source.next();
      if (next.done) return false;
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : Buffer.from(next.value);
    }
    return true;
  }
  async read(n: number): Promise<Buffer> {
    if (!(await this.fill(n))) throw new Error(`ZIP ended early at byte ${this.offset + this.buffer.length}.`);
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    this.offset += n;
    return out;
  }
  /** Passes `n` bytes to `sink` without holding more than one source chunk. */
  async pipe(n: number, sink: (chunk: Buffer) => void) {
    while (n > 0) {
      if (!this.buffer.length && !(await this.fill(1))) throw new Error("ZIP ended inside an entry.");
      const take = this.buffer.subarray(0, Math.min(n, this.buffer.length));
      sink(take);
      this.buffer = this.buffer.subarray(take.length);
      this.offset += take.length;
      n -= take.length;
    }
  }
  async ended() {
    return !(await this.fill(1));
  }
}

function zip64Sizes(extra: Buffer) {
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (id === 0x0001) return extra.subarray(at + 4, at + 4 + length);
    at += 4 + length;
  }
  return null;
}

/**
 * Reads a whole ZIP stream front to back: every local entry's payload is hashed and checked against
 * its CRC32, and the central directory must list the same entries at the same offsets. Supports the
 * stored (uncompressed) ZIP64 layout Relay produces and rejects anything else.
 */
export async function readZip(stream: AsyncIterable<Uint8Array>): Promise<ZipFile[]> {
  const reader = new Reader(stream);
  const entries: (ZipFile & { offset: number })[] = [];
  let signature: number;
  for (;;) {
    const offset = reader.offset;
    signature = (await reader.read(4)).readUInt32LE(0);
    if (signature !== 0x04034b50) break;
    const header = await reader.read(26);
    const flags = header.readUInt16LE(2);
    if (header.readUInt16LE(4) !== 0) throw new Error("ZIP entry is compressed.");
    if (flags & 0x0008) throw new Error("ZIP entry uses a data descriptor.");
    const crc = header.readUInt32LE(10);
    let size = header.readUInt32LE(18);
    const name = (await reader.read(header.readUInt16LE(22))).toString("utf8");
    const extra = await reader.read(header.readUInt16LE(24));
    if (size === 0xffffffff) {
      const z64 = zip64Sizes(extra);
      if (!z64) throw new Error(`ZIP entry ${name} lacks its ZIP64 sizes.`);
      size = Number(z64.readBigUInt64LE(0));
    }
    const hash = createHash("sha256");
    let actualCrc = 0;
    await reader.pipe(size, (chunk) => {
      hash.update(chunk);
      actualCrc = crc32(chunk, actualCrc);
    });
    if (actualCrc >>> 0 !== crc) throw new Error(`CRC32 mismatch in ${name}.`);
    const folder = name.endsWith("/");
    entries.push({ path: folder ? name.slice(0, -1) : name, folder, size, sha256: hash.digest("hex"), offset });
  }
  let index = 0;
  while (signature === 0x02014b50) {
    const header = await reader.read(42);
    const name = (await reader.read(header.readUInt16LE(24))).toString("utf8");
    const extra = await reader.read(header.readUInt16LE(26));
    await reader.read(header.readUInt16LE(28));
    let offset = header.readUInt32LE(38);
    if (offset === 0xffffffff) offset = Number(zip64Sizes(extra)!.readBigUInt64LE(16));
    const local = entries[index++];
    if (!local || (local.folder ? `${local.path}/` : local.path) !== name || local.offset !== offset)
      throw new Error(`Central directory entry ${name} does not match the local entries.`);
    signature = (await reader.read(4)).readUInt32LE(0);
  }
  if (index !== entries.length) throw new Error("The central directory is missing entries.");
  if (signature !== 0x06064b50) throw new Error("ZIP64 end of central directory record missing.");
  const end64 = await reader.read(Number((await reader.read(8)).readBigUInt64LE(0)));
  if (Number(end64.readBigUInt64LE(20)) !== entries.length) throw new Error("ZIP64 entry count is wrong.");
  if ((await reader.read(20)).readUInt32LE(0) !== 0x07064b50) throw new Error("ZIP64 locator missing.");
  const end = await reader.read(22);
  if (end.readUInt32LE(0) !== 0x06054b50) throw new Error("End of central directory record missing.");
  await reader.read(end.readUInt16LE(20));
  if (!(await reader.ended())) throw new Error("Bytes follow the end of the ZIP.");
  return entries.map(({ offset: _, ...entry }) => entry);
}

// ---- fixtures ----

/** A deterministic folder of `count` files of 0–12 KiB under `root`, with nested paths and some non-ASCII names. */
export function folderFixture(root: string, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const size = i % 97 === 0 ? 0 : (i * 7919) % 12_289;
    const seed = createHash("sha256").update(`relay-fixture-${i}`).digest();
    const data = Buffer.alloc(size);
    for (let at = 0; at < size; at += seed.length) seed.copy(data, at);
    const name = i % 250 === 0 ? `résumé ${i}.bin` : `file-${String(i).padStart(5, "0")}.bin`;
    return { path: `${root}/module-${String(Math.floor(i / 100)).padStart(3, "0")}/part-${i % 3}/${name}`, data };
  });
}

/** Every folder that `paths` imply, as "/"-separated paths. */
export function parentsOf(paths: string[]) {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  return folders;
}

/** A one-page PDF drawn with a filled square. */
export function pdfFixture() {
  const stream = "0 0 1 rg\n20 20 160 160 re f\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

// ---- disposable local servers ----

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export const LOCAL_PASSWORD = "Verification-password-only";
const LOCAL_SECRET = "verification-secret-that-is-long-enough-0000";

export async function waitForHealth(origin: string, timeoutMs: number, alive: () => boolean = () => true) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!alive()) throw new Error("The server exited before it became healthy.");
    try {
      if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2_000) })).ok) return Date.now() - started;
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error(`${origin} did not become healthy within ${timeoutMs} ms.`);
}

export type LocalServer = {
  origin: string;
  child: ChildProcess;
  /** Milliseconds from spawn to a healthy /api/health. */
  startupMs: number;
  /** Sends `signal` and waits for the exit; escalates to SIGKILL after `graceMs`. */
  stop: (signal?: NodeJS.Signals, graceMs?: number) => Promise<{ code: number | null; ms: number; forced: boolean }>;
};

/**
 * Runs `node server/main.ts` as its own process on a disposable data directory. Only RELAY_*
 * variables set here reach it, so a caller's environment can never point it at real data.
 */
export async function startServer(options: {
  root: string;
  port: number;
  cwd?: string;
  log: string;
}): Promise<LocalServer> {
  const origin = `http://127.0.0.1:${options.port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RELAY_")));
  const log = createWriteStream(options.log, { flags: "a" });
  const started = Date.now();
  const child = spawn(process.execPath, [join(REPO, "server", "main.ts")], {
    cwd: options.cwd ?? REPO,
    env: {
      ...env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(options.port),
      RELAY_DATA: options.root,
      RELAY_BACKUP_DIR: join(options.root, "..", "backups"),
      RELAY_ORIGIN: origin,
      RELAY_ADMIN_PASSWORD: LOCAL_PASSWORD,
      RELAY_SECRET: LOCAL_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let exited: { code: number | null } | null = null;
  const exit = new Promise<{ code: number | null }>((resolve) =>
    child.once("exit", (code) => resolve((exited = { code }))),
  );
  child.once("close", () => log.end());
  try {
    await waitForHealth(origin, 30_000, () => !exited);
  } catch (error) {
    child.kill("SIGKILL");
    await exit;
    throw error;
  }
  return {
    origin,
    child,
    startupMs: Date.now() - started,
    stop: async (signal = "SIGTERM", graceMs = 30_000) => {
      const t = Date.now();
      if (!exited) child.kill(signal);
      let forced = false;
      const timer = setTimeout(() => {
        forced = true;
        child.kill("SIGKILL");
      }, graceMs);
      const { code } = await exit;
      clearTimeout(timer);
      return { code, ms: Date.now() - t, forced };
    },
  };
}

// ---- reporting ----

export const mib = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;

/** Parses sizes like 2GiB, 64MiB, 512KiB or plain bytes. */
export function parseSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(|B|KiB|MiB|GiB)$/i.exec(value.trim());
  if (!match) throw new Error(`Cannot read the size "${value}".`);
  const unit = { "": 1, b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 }[match[2].toLowerCase()]!;
  return Math.round(Number(match[1]) * unit);
}

/** Runs a named step, printing its duration; the returned timings feed the final summary. */
export function stepper() {
  const timings: Record<string, number> = {};
  return {
    timings,
    step: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
      const started = performance.now();
      process.stdout.write(`- ${name} ... `);
      try {
        const value = await fn();
        timings[name] = Math.round(performance.now() - started) / 1000;
        console.log(`ok (${timings[name]} s)`);
        return value;
      } catch (error) {
        console.log("FAILED");
        throw error;
      }
    },
  };
}

/** An error's stack for a failure report, or the thrown value itself. */
export const errorStack = (error: unknown) => (error instanceof Error ? (error.stack ?? error.message) : String(error));
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
