// Verifies the production image on disposable Docker containers and volumes:
//   1. a second Relay process on the same data volume is refused at once (SQLite exclusive lock);
//   2. SIGKILL while a chunk is half received, then a restart that is healthy immediately (no
//      stale-lock wait), resumes from HEAD's offset and serves the file with the source's SHA-256;
//   3. a full disk (small tmpfs) refuses new transfers with 507, a chunk that hits ENOSPC answers 507
//      without moving the offset, and the same upload succeeds after space is freed.
// Every container and volume is named relay-verify-<run>-* and removed afterwards. The live `relay`
// compose project, its volumes and its network are never touched.
//
// Usage: npm run verify:container -- [--skip-build] [--payload 96MiB]
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { api, urls } from "../shared/api.ts";
import { LIMITS } from "../shared/model.ts";
import {
  REPO,
  Session,
  assert,
  bufferSource,
  download,
  freePort,
  mib,
  parseSize,
  patch,
  sha256,
  sleep,
  stalledPatch,
  stepper,
  upload,
  uploadOffset,
  waitForHealth,
  errorStack,
  HttpError,
} from "./lib/relay.ts";

const { values: flags } = parseArgs({
  options: {
    "skip-build": { type: "boolean", default: false },
    payload: { type: "string", default: "96MiB" },
  },
});
const IMAGE = "relay-verify";
const PASSWORD = "Container-verification-password-only";
const SECRET = "container-verification-secret-that-is-long-enough";
const run = `relay-verify-${Date.now().toString(36)}`;
const names = { primary: `${run}-primary`, second: `${run}-second`, disk: `${run}-disk` };
const volumes = { data: `${run}-data`, backups: `${run}-backups` };
for (const name of [...Object.values(names), ...Object.values(volumes)])
  assert(name.startsWith("relay-verify-"), `Refusing to use ${name}.`);

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// The same hardening as compose.yaml, so the image is exercised the way it is deployed.
const hardened = [
  "--init",
  "--read-only",
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,size=64m",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges:true",
];
const environment = (origin: string) => [
  "-e",
  `RELAY_ORIGIN=${origin}`,
  "-e",
  `RELAY_ADMIN_PASSWORD=${PASSWORD}`,
  "-e",
  `RELAY_SECRET=${SECRET}`,
];
const volumeMounts = ["-v", `${volumes.data}:/data`, "-v", `${volumes.backups}:/backups`];

async function startContainer(name: string, storage: string[], extra: string[] = []) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "relay-verify=1",
    "-p",
    `127.0.0.1:${port}:3090`,
    ...hardened,
    ...extra,
    ...environment(origin),
    ...storage,
    IMAGE,
  );
  await waitForHealth(origin, 60_000);
  const session = new Session(origin);
  await session.signIn("admin", PASSWORD, "Container verification");
  return session;
}
const partSize = (container: string, upload: string) =>
  Number(
    spawnSync("docker", ["exec", container, "stat", "-c", "%s", `/data/uploads/${upload}.part`], {
      encoding: "utf8",
    }).stdout.trim() || -1,
  );

async function createTransfer(session: Session, path: string, size: number) {
  return session.call(api.transfers.create, {
    body: {
      id: crypto.randomUUID(),
      tab: session.tab,
      name: null,
      files: [{ path, size, mime: "application/octet-stream" }],
    },
  });
}
async function finishAndVerify(session: Session, transfer: { id: string; itemId: string }, expected: string) {
  await session.call(api.transfers.complete, { params: { id: transfer.id }, body: { destination: { kind: "save" } } });
  const item = await session.call(api.items.get, { params: { id: transfer.itemId } });
  const got = await download(session, urls.nodeContent(item.nodes.find((n) => n.kind === "file")!.id));
  assert(got.sha256 === expected, "The downloaded SHA-256 differs from the source.");
}

const { step, timings } = stepper();
const facts: Record<string, unknown> = { image: IMAGE, run };
let builtImage = false;
const payload = randomBytes(parseSize(flags.payload));
const payloadHash = sha256(payload);
assert(payload.length > LIMITS.chunkBytes, "--payload must be larger than one chunk.");

try {
  if (!flags["skip-build"])
    await step(`docker build -t ${IMAGE} .`, () => {
      const built = spawnSync("docker", ["build", "--progress", "plain", "-t", IMAGE, "."], {
        cwd: REPO,
        encoding: "utf8",
      });
      assert(built.status === 0, `docker build failed:\n${built.stderr.trim().split("\n").slice(-40).join("\n")}`);
      builtImage = true;
    });
  docker("volume", "create", "--label", "relay-verify=1", volumes.data);
  docker("volume", "create", "--label", "relay-verify=1", volumes.backups);
  let session = await step("start the primary container", () =>
    startContainer(names.primary, volumeMounts, ["--memory", "500m"]),
  );

  await step("a second writer on the same volume is refused", () => {
    const started = Date.now();
    const second = spawnSync(
      "docker",
      ["run", "--name", names.second, ...hardened, ...environment("http://127.0.0.1:1"), ...volumeMounts, IMAGE],
      { encoding: "utf8", timeout: 60_000 },
    );
    facts.secondWriterMs = Date.now() - started;
    assert(second.status !== 0, "The second container kept running on a volume that is in use.");
    assert(
      `${second.stdout}${second.stderr}`.includes("Another Relay process is using this data directory."),
      `The second container failed without the lock message:\n${second.stderr.slice(-2000)}`,
    );
  });
  await step("the primary is unaffected", () => waitForHealth(session.origin, 5_000));

  await step(`SIGKILL with a half-received chunk of a ${mib(payload.length)} upload`, async () => {
    const transfer = await createTransfer(session, "crash/payload.bin", payload.length);
    const id = transfer.uploads[0].id;
    const source = bufferSource(payload);
    await upload(session, id, source, { until: LIMITS.chunkBytes });
    const half = Math.min(LIMITS.chunkBytes / 2, payload.length - LIMITS.chunkBytes);
    const stalled = stalledPatch(
      session,
      id,
      LIMITS.chunkBytes,
      payload.subarray(LIMITS.chunkBytes, LIMITS.chunkBytes + half),
    );
    await stalled.delivered;
    for (let i = 0; partSize(names.primary, id) !== LIMITS.chunkBytes + half; i++) {
      assert(i < 300, "The container never wrote the half chunk.");
      await sleep(100);
    }
    docker("kill", "--signal", "KILL", names.primary);
    stalled.abort();
    await stalled.result;

    const started = Date.now();
    docker("start", names.primary);
    await waitForHealth(session.origin, 60_000);
    const restartMs = (facts.restartAfterKillMs = Date.now() - started);
    assert(restartMs < 15_000, `Restart after SIGKILL took ${restartMs} ms.`);

    const offset = await uploadOffset(session, id);
    assert(offset === LIMITS.chunkBytes, `HEAD reported ${offset} after the crash, expected ${LIMITS.chunkBytes}.`);
    await upload(session, id, source);
    await finishAndVerify(session, transfer, payloadHash);
  });

  await step("ENOSPC on a small tmpfs data volume", async () => {
    session = await startContainer(names.disk, [
      "--tmpfs",
      "/data:rw,size=400m,uid=1000,gid=1000,mode=0700",
      "--tmpfs",
      "/backups:rw,size=16m,uid=1000,gid=1000,mode=0700",
    ]);
    const chunk = payload.subarray(0, LIMITS.chunkBytes);
    const transfer = await createTransfer(session, "full/payload.bin", chunk.length);
    const id = transfer.uploads[0].id;
    docker(
      "exec",
      names.disk,
      "node",
      "-e",
      "const fs=require('fs');const d=fs.statfsSync('/data');const n=Math.floor(d.bavail*d.bsize/1048576)-4;" +
        "const f=fs.openSync('/data/filler','w');const b=Buffer.alloc(1048576,1);for(let i=0;i<n;i++)fs.writeSync(f,b);fs.closeSync(f)",
    );
    const admission = await createTransfer(session, "full/other.bin", 1024).then(
      () => 0,
      (error: unknown) => (error instanceof HttpError ? error.status : 0),
    );
    const write = await patch(session, id, 0, chunk);
    const offsetAfter = await uploadOffset(session, id);
    facts.enospc = { admissionStatus: admission, patchStatus: write.status, patchMessage: write.text, offsetAfter };

    docker("exec", names.disk, "rm", "/data/filler");
    await upload(session, id, bufferSource(chunk));
    await finishAndVerify(session, transfer, sha256(chunk));

    assert(admission === 507, `A new transfer on a full disk answered ${admission}, expected 507.`);
    assert(write.status === 507, `A chunk that hit ENOSPC answered ${write.status} (${write.text}), expected 507.`);
    assert(offsetAfter === 0, `The offset moved to ${offsetAfter} after ENOSPC.`);
  });

  console.log(JSON.stringify({ passed: true, ...facts, timings }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(`\nverify-container failed: ${errorStack(error)}`);
  console.error(JSON.stringify(facts, null, 2));
  for (const name of Object.values(names)) {
    const logs = spawnSync("docker", ["logs", "--tail", "15", name], { encoding: "utf8" });
    if (logs.status === 0) console.error(`--- ${name} ---\n${logs.stdout}${logs.stderr}`);
  }
} finally {
  const cleanup = (args: string[]) => {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0 && !/No such (container|volume|image)/i.test(result.stderr ?? "")) {
      console.error(`Cleanup failed: docker ${args.join(" ")}: ${result.error ?? result.stderr}`);
      process.exitCode = 1;
    }
  };
  for (const name of Object.values(names)) cleanup(["rm", "-f", name]);
  for (const volume of Object.values(volumes)) cleanup(["volume", "rm", volume]);
  if (builtImage) cleanup(["image", "rm", IMAGE]);
}
