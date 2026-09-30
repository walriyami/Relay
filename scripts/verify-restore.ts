// Actual Docker/Compose restore regression. Reuses the already-built local relay-verify image;
// all projects, volumes, images and files are unique synthetic fixtures. Never reads .env or user data.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { api, urls } from "../shared/api.ts";
import {
  REPO,
  Session,
  LOCAL_PASSWORD,
  assert,
  freePort,
  setUpAdmin,
  sendFiles,
  sha256,
  download,
  sleep,
  waitForHealth,
} from "./lib/relay.ts";

const run = `relay-verify-restore-${randomUUID().slice(0, 12)}`;
const image = `${run}:fixture`;
const volume = `${run}_relay-data`;
const work = await mkdtemp(join(tmpdir(), `${run}-`));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("RELAY_") && !key.startsWith("COMPOSE_")),
);
Object.assign(env, { COMPOSE_FILE: "compose.yaml", BUILDX_BUILDER: "default" });
const docker = (...args: string[]) =>
  execFileSync("docker", args, { cwd: work, env, encoding: "utf8", timeout: 180_000 }).trim();
const compose = (...args: string[]) => docker("compose", "-p", run, "-f", "compose.yaml", ...args);
const saved = () => docker("volume", "ls", "-q", "--filter", `name=^${volume}-saved-`).split("\n").filter(Boolean);
const digest = (name: string) => {
  assert(name === volume || name.startsWith(`${volume}-saved-`), `Unexpected volume ${name}`);
  return docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "0",
    "-v",
    `${name}:/fixture:ro`,
    "--entrypoint",
    "node",
    "relay-verify",
    "-e",
    "const fs=require('fs'),p=require('path'),c=require('crypto');const h=c.createHash('sha256');" +
      "function scan(d){for(const n of fs.readdirSync(d).sort()){const f=p.join(d,n),s=fs.lstatSync(f);" +
      "h.update(p.relative('/fixture',f));if(s.isDirectory())scan(f);else if(s.isSymbolicLink())h.update(fs.readlinkSync(f));else h.update(fs.readFileSync(f));}}" +
      "scan('/fixture');console.log(h.digest('hex'));",
  );
};
const redeploy = (data: string) =>
  spawnSync("bash", ["scripts/redeploy.sh", "--from", "working", "--data", data, "-y"], {
    cwd: work,
    env,
    encoding: "utf8",
    timeout: 180_000,
  });
const healthy = async (origin: string) => {
  await waitForHealth(origin, 60_000);
  assert(
    docker("inspect", "-f", "{{.State.Health.Status}}", compose("ps", "-q", "relay")) === "healthy",
    "Docker health is not healthy",
  );
};
const facts: Record<string, unknown> = { run, sourceImage: "relay-verify" };

try {
  docker("image", "inspect", "relay-verify"); // Fail before creating resources if CI's local image is absent.
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  await mkdir(join(work, "scripts"));
  await writeFile(join(work, "scripts", "redeploy.sh"), await readFile(join(REPO, "scripts", "redeploy.sh")));
  // The copy wrapper injects a failure only for an explicitly marked synthetic source. Normal
  // cases run Debian's actual cp. This creates no registry access and changes no Relay code.
  const wrapper =
    '#!/bin/sh\nif [ -e /from/.simulate-copy-failure ]; then echo "Synthetic copy failure" >&2; exit 9; fi\nexec /bin/cp "$@"\n';
  const installWrapper = `require('fs').writeFileSync('/usr/local/bin/cp',${JSON.stringify(wrapper)},{mode:0o755})`;
  await writeFile(
    join(work, "Dockerfile"),
    `FROM relay-verify\nUSER root\nRUN ${JSON.stringify(["node", "-e", installWrapper])}\nUSER node\n`,
  );
  await writeFile(
    join(work, "compose.yaml"),
    JSON.stringify({
      name: run,
      services: {
        relay: {
          image,
          init: true,
          environment: { RELAY_DIRECT: "false", RELAY_ORIGIN: origin },
          ports: [`127.0.0.1:${port}:3090`],
          volumes: ["relay-data:/data"],
          stop_grace_period: "30s",
        },
      },
      volumes: { "relay-data": {} },
    }),
  );
  execFileSync("git", ["init", "-q"], { cwd: work, env });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Restore fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "synthetic fixture",
    ],
    { cwd: work, env },
  );
  docker("build", "--builder", "default", "--pull=false", "-t", image, ".");
  compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "90");
  await setUpAdmin(origin, LOCAL_PASSWORD, () => "");
  const owner = new Session(origin);
  await owner.signIn("admin", LOCAL_PASSWORD, "Restore fixture");
  await owner.call(api.admin.settings, { body: { codeLength: 6 } });
  const payload = Buffer.from("Synthetic Docker restore payload\n".repeat(4096));
  const sent = await sendFiles(owner, [{ path: "synthetic.bin", data: payload }]);
  const node = (await owner.call(api.items.get, { params: { id: sent.created.itemId } })).nodes[0];
  const beforeSettings = await owner.call(api.admin.overview);
  const beforeContainer = compose("ps", "-q", "relay");
  const rejected = redeploy(`restore=${volume}`);
  assert(rejected.status === 1 && rejected.stderr.includes("onto itself"), "Self-restore was not rejected");
  assert(compose("ps", "-q", "relay") === beforeContainer, "Self-restore replaced/stopped Relay");
  await healthy(origin);
  assert((await download(owner, urls.nodeContent(node.id))).sha256 === sha256(payload), "Self-restore changed payload");
  assert(saved().length === 0, "Self-restore created a backup");
  facts.selfRestoreRejected = true;

  const savedResult = redeploy("save");
  assert(savedResult.status === 0, `Save failed: ${savedResult.stderr}\n${savedResult.stdout}`);
  await healthy(origin);
  assert((await new Session(origin).call(api.setup.status)).state === "account", "Save did not start empty");
  const snapshot = saved()[0];
  assert(snapshot, "No saved original volume");
  const snapshotHash = digest(snapshot);
  await sleep(1100); // Avoid same-second saved-volume names between independent operations.
  const restored = redeploy(`restore=${snapshot}`);
  assert(restored.status === 0, `Restore failed: ${restored.stderr}\n${restored.stdout}`);
  await healthy(origin);
  const verify = async () => {
    const client = new Session(origin);
    await client.signIn("admin", LOCAL_PASSWORD, "Restored fixture");
    const settings = await client.call(api.admin.overview);
    assert(
      settings.codeLength === 6 && settings.limits.capacity === beforeSettings.limits.capacity,
      "Settings changed on restore",
    );
    assert(
      (await download(client, urls.nodeContent(node.id))).sha256 === sha256(payload),
      "Restored file hash differs",
    );
  };
  await verify();
  assert(digest(snapshot) === snapshotHash, "Restore changed its source volume");
  facts.restore = {
    bytes: payload.length,
    sha256: sha256(payload),
    sourceDigest: snapshotHash,
    sourcePreserved: true,
    settingsPreserved: true,
  };

  // Mark only a disposable saved source. The real destructive copy clears the destination,
  // then our fixture wrapper fails; the completed pre-restore backup must enable recovery.
  docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "0",
    "-v",
    `${snapshot}:/fixture`,
    "--entrypoint",
    "node",
    "relay-verify",
    "-e",
    "require('fs').writeFileSync('/fixture/.simulate-copy-failure','synthetic only')",
  );
  const failedSourceHash = digest(snapshot);
  const oldSaved = new Set(saved());
  await sleep(1100);
  const failed = redeploy(`restore=${snapshot}`);
  assert(
    failed.status === 1 && failed.stderr.includes("Do not start it with the partially restored data"),
    "Copy failure did not report safe recovery",
  );
  assert(compose("ps", "-q", "relay") === "", "Failed restore left Relay running");
  assert(digest(snapshot) === failedSourceHash, "Failed restore changed its source");
  const recovery = saved().find((name) => !oldSaved.has(name));
  assert(recovery && failed.stderr.includes(`restore=${recovery}`), "Recovery backup was not identified");
  const recoveryHash = digest(recovery);
  await sleep(1100);
  const recovered = redeploy(`restore=${recovery}`);
  assert(recovered.status === 0, `Recovery failed: ${recovered.stderr}\n${recovered.stdout}`);
  await healthy(origin);
  await verify();
  assert(digest(recovery) === recoveryHash, "Recovery changed its source backup");
  facts.copyFailureRecovery = { stoppedOnFailure: true, recovered: true, backupPreserved: true };
} catch (error) {
  process.exitCode = 1;
  console.error(error);
} finally {
  // Attempt every cleanup independently; never target the user's relay project or generic volumes.
  const cleanup = (args: string[]) => {
    const result = spawnSync("docker", args, { cwd: work, env, encoding: "utf8", timeout: 60_000 });
    if (result.status !== 0 && !/No such (image|volume|container)|not found/i.test(result.stderr ?? "")) {
      console.error(`Cleanup failed: docker ${args.join(" ")}: ${result.stderr}`);
      process.exitCode = 1;
    }
  };
  if (
    await readFile(join(work, "compose.yaml")).then(
      () => true,
      () => false,
    )
  )
    cleanup(["compose", "-p", run, "-f", "compose.yaml", "down", "--volumes", "--remove-orphans", "--timeout", "30"]);
  const volumes = spawnSync("docker", ["volume", "ls", "-q", "--filter", `name=^${volume}-saved-`], {
    cwd: work,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (volumes.status !== 0) {
    console.error("Could not enumerate synthetic saved volumes for cleanup.");
    process.exitCode = 1;
  }
  for (const name of (volumes.stdout ?? "").trim().split("\n").filter(Boolean)) {
    assert(name.startsWith(`${volume}-saved-`), `Unexpected cleanup volume ${name}`);
    cleanup(["volume", "rm", name]);
  }
  cleanup(["image", "rm", image, `${run}:rollback`]);
  try {
    const remainingContainers = docker("ps", "-aq", "--filter", `label=com.docker.compose.project=${run}`);
    const remainingVolumes = docker("volume", "ls", "-q", "--filter", `name=^${volume}($|-saved-)`);
    const remainingNetworks = docker("network", "ls", "-q", "--filter", `label=com.docker.compose.project=${run}`);
    const remainingImages = docker("image", "ls", "-q", "--filter", `reference=${run}:*`);
    assert(
      !remainingContainers && !remainingVolumes && !remainingNetworks && !remainingImages,
      "Synthetic Docker resources remain after cleanup",
    );
    facts.teardownVerified = true;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  await rm(work, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: !process.exitCode, ...facts }, null, 2));
}
