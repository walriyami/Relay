// Verifies Relay at scale against a real Relay process on a disposable data directory:
//   1. a generated multi-GB file uploaded with tus over HTTP, with the server stopped mid-chunk and a
//      new process started on the same directory; the upload resumes from HEAD's offset and the
//      streamed download's SHA-256 equals the source;
//   2. a 10,000-file folder transfer whose streaming ZIP lists exactly the expected entries with
//      every payload hash (checked by our reader and by Python's zipfile), plus a download that is
//      interrupted and resumed with Range and matches the full archive.
//
// Usage: npm run verify:scale -- [--size 2GiB] [--files 10000] [--dir <parent>] [--keep]
// Quick run: npm run verify:scale -- --size 80MiB --files 300
import { execFileSync } from "node:child_process";
import { createHash, randomFillSync } from "node:crypto";
import { closeSync, createReadStream, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { api, urls } from "../shared/api.ts";
import { LIMITS } from "../shared/model.ts";
import {
  LOCAL_PASSWORD,
  Session,
  assert,
  consume,
  download,
  fileSource,
  folderFixture,
  freePort,
  mib,
  parentsOf,
  parseSize,
  readZip,
  resumedDownload,
  sendFiles,
  sha256,
  stalledPatch,
  startServer,
  stepper,
  upload,
  uploadOffset,
  sleep,
  type LocalServer,
  errorStack,
} from "./lib/relay.ts";

const { values: flags } = parseArgs({
  options: {
    size: { type: "string", default: "2GiB" },
    files: { type: "string", default: "10000" },
    dir: { type: "string", default: tmpdir() },
    keep: { type: "boolean", default: false },
  },
});
const size = parseSize(flags.size);
const fileCount = Number(flags.files);
assert(size > 0 && Number.isInteger(fileCount) && fileCount > 0, "--size and --files must be positive.");

const work = await mkdtemp(join(flags.dir, "relay-verify-scale-"));
const root = join(work, "data");
const log = join(work, "server.log");
const port = await freePort();
const { step, timings } = stepper();
const facts: Record<string, unknown> = { size, files: fileCount, work };
let server: LocalServer | null = null;

try {
  const disk = await statfs(work);
  const needed = size * 2 + fileCount * 16_384 * 3 + 512 * 1024 ** 2;
  assert(disk.bavail * disk.bsize > needed, `Needs about ${mib(needed)} free under ${flags.dir}.`);

  const source = join(work, "source.bin");
  const sourceHash = await step(`generate ${mib(size)} source file`, () => {
    const hash = createHash("sha256");
    const block = Buffer.allocUnsafe(LIMITS.chunkBytes);
    const fd = openSync(source, "w");
    try {
      for (let at = 0; at < size; at += block.length) {
        const piece = block.subarray(0, Math.min(block.length, size - at));
        randomFillSync(piece);
        hash.update(piece);
        writeSync(fd, piece);
      }
    } finally {
      closeSync(fd);
    }
    return hash.digest("hex");
  });

  server = await startServer({ root, port, log });
  facts.firstStartupMs = server.startupMs;
  const session = new Session(server.origin);
  await session.signIn("admin", LOCAL_PASSWORD, "Scale verification");

  const created = await session.call(api.transfers.create, {
    body: {
      id: crypto.randomUUID(),
      tab: session.tab,
      name: null,
      files: [{ path: "large/source.bin", size, mime: "application/octet-stream" }],
    },
  });
  const uploadId = created.uploads[0].id;
  const file = fileSource(source, size);
  const committed = Math.floor((size * 0.4) / LIMITS.chunkBytes) * LIMITS.chunkBytes;

  await step(`upload the first ${mib(committed)}`, () => upload(session, uploadId, file, { until: committed }));

  await step("stop the server while a chunk is half received", async () => {
    const pending = Math.max(1, Math.floor(Math.min(LIMITS.chunkBytes, size - committed) / 2));
    const stalled = stalledPatch(session, uploadId, committed, file.read(committed, pending));
    await stalled.delivered;
    const part = join(root, "uploads", `${uploadId}.part`);
    for (let i = 0; statSync(part, { throwIfNoEntry: false })?.size !== committed + pending; i++) {
      assert(i < 600, "The server never wrote the half chunk to its part file.");
      await sleep(50);
    }
    const stopped = await server!.stop("SIGTERM");
    stalled.abort();
    const result = await stalled.result;
    assert(result.status !== 204, "The interrupted PATCH must not report success.");
    facts.stopMs = stopped.ms;
    facts.stopForced = stopped.forced;
    assert(!stopped.forced, `The server did not exit within 30 s of SIGTERM with an upload in flight.`);
  });

  server = await step("start a new process on the same directory", () => startServer({ root, port, log }));
  facts.restartMs = server.startupMs;

  await step("resume from HEAD's offset and finish", async () => {
    const offset = await uploadOffset(session, uploadId);
    assert(offset === committed, `HEAD reported ${offset}, expected the committed ${committed}.`);
    const part = statSync(join(root, "uploads", `${uploadId}.part`), { throwIfNoEntry: false })?.size ?? 0;
    assert(part === committed, `The part file holds ${part} bytes after restart, expected ${committed}.`);
    const started = performance.now();
    await upload(session, uploadId, file);
    facts.uploadMiBps = Math.round((size - committed) / 1024 ** 2 / ((performance.now() - started) / 1000));
    await session.call(api.transfers.complete, {
      params: { id: created.id },
      body: { destination: { kind: "save" } },
    });
  });

  const item = await session.call(api.items.get, { params: { id: created.itemId } });
  const node = item.nodes.find((n) => n.kind === "file")!;
  assert(node.path === "large/source.bin" && node.size === size, "The saved file has the wrong path or size.");

  await step("stream the download and compare SHA-256", async () => {
    const started = performance.now();
    const got = await download(session, urls.nodeContent(node.id));
    facts.downloadMiBps = Math.round(size / 1024 ** 2 / ((performance.now() - started) / 1000));
    assert(got.bytes === size, `Downloaded ${got.bytes} bytes, expected ${size}.`);
    assert(got.sha256 === sourceHash, "The downloaded SHA-256 differs from the source.");
  });

  await step("byte ranges of the large file", async () => {
    for (const [start, end] of [
      [0, Math.min(size - 1, 1023)],
      [Math.floor(size / 2), Math.min(size - 1, Math.floor(size / 2) + 65_535)],
      [Math.max(0, size - 1024 ** 2), size - 1],
    ]) {
      const got = await download(session, urls.nodeContent(node.id), { headers: { range: `bytes=${start}-${end}` } });
      assert(got.res.status === 206, `Range ${start}-${end} answered ${got.res.status}.`);
      assert(got.sha256 === sha256(file.read(start, end - start + 1)), `Range ${start}-${end} has the wrong bytes.`);
    }
  });

  const fixture = folderFixture("scale", fileCount);
  const text = "Relay scale verification text\n";
  const folder = await step(`send a ${fileCount}-file folder`, () =>
    sendFiles(session, fixture, { text, folders: ["scale/empty"], parallel: 16 }),
  );

  const expected = new Map<string, { folder: boolean; sha256: string | null }>();
  for (const path of [...parentsOf(fixture.map((f) => f.path)), "scale/empty"])
    expected.set(path, { folder: true, sha256: null });
  for (const f of fixture) expected.set(f.path, { folder: false, sha256: sha256(f.data) });
  expected.set("Text.txt", { folder: false, sha256: sha256(text) });

  await step("library paths of the folder transfer", async () => {
    const detail = await session.call(api.items.get, { params: { id: folder.created.itemId } });
    assert(
      detail.nodes.length === expected.size,
      `The item has ${detail.nodes.length} nodes, expected ${expected.size}.`,
    );
    for (const n of detail.nodes) {
      const want = expected.get(n.path);
      assert(want && want.folder === (n.kind === "folder"), `Unexpected node ${n.path}.`);
    }
  });

  const zipFile = join(work, "folder.zip");
  const full = await step("download the streaming ZIP", async () => {
    const res = await session.fetch(urls.itemZip(folder.created.itemId));
    assert(res.status === 200, `ZIP answered ${res.status}.`);
    const length = Number(res.headers.get("content-length"));
    const got = await consume(res, zipFile);
    assert(got.bytes === length, `ZIP has ${got.bytes} bytes but Content-Length said ${length}.`);
    facts.zipBytes = got.bytes;
    return got;
  });

  await step("ZIP entry list and every payload hash", async () => {
    const entries = await readZip(createReadStream(zipFile));
    assert(entries.length === expected.size, `ZIP has ${entries.length} entries, expected ${expected.size}.`);
    for (const entry of entries) {
      const want = expected.get(entry.path);
      assert(want && want.folder === entry.folder, `Unexpected ZIP entry ${entry.path}.`);
      assert(entry.folder || entry.sha256 === want.sha256, `Wrong payload in ${entry.path}.`);
    }
    assert(new Set(entries.map((e) => e.path)).size === expected.size, "ZIP contains duplicate paths.");
    facts.zipEntries = entries.length;
  });

  await step("Python zipfile reads the archive", () => {
    const out = execFileSync(
      "python3",
      [
        "-c",
        "import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nbad = z.testzip()\nprint(len(z.namelist()), bad)\nsys.exit(1 if bad else 0)",
        zipFile,
      ],
      { encoding: "utf8" },
    ).trim();
    assert(out === `${expected.size} None`, `Python zipfile reported: ${out}`);
  });

  await step("interrupted ZIP download resumed with Range", async () => {
    const resumed = await resumedDownload(session, urls.itemZip(folder.created.itemId), 0.5);
    assert(resumed.bytes === full.bytes, "The resumed ZIP has a different length.");
    assert(resumed.sha256 === full.sha256, "The resumed ZIP differs from the full download.");
    assert(resumed.sha256 === sha256(readFileSync(zipFile)), "The saved ZIP differs from its streamed hash.");
  });

  console.log(JSON.stringify({ passed: true, ...facts, timings }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(`\nverify-scale failed: ${errorStack(error)}`);
  try {
    console.error(`--- last server log lines (${log}) ---`);
    console.error(readFileSync(log, "utf8").trim().split("\n").slice(-20).join("\n"));
  } catch {
    // No log was written.
  }
} finally {
  await server?.stop("SIGTERM");
  if (flags.keep) console.log(`Kept ${work}`);
  else await rm(work, { recursive: true, force: true });
}
