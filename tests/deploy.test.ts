import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// deploy/ (Docker + Cloudflare Tunnel): the shell scripts run against a stand-in `docker` that records
// what it was asked and plays the container's part on a folder, and the configuration is read for the
// settings that keep Relay cut off. Nothing here starts Docker.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DEPLOY = join(REPO, "deploy");
const read = (file: string) => readFile(join(REPO, file), "utf8");

/**
 * Stands in for `docker`. `compose run ... tar -czf - -C /data .` archives $FAKE_DATA, and
 * `compose run ... sh -c <script>` runs the script with /data meaning $FAKE_DATA. FAKE_FAIL names a
 * step to fail ("run", "dns"); FAKE_ARCHIVE=truncated cuts the archive short.
 */
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$*" in
  "compose run"*"--entrypoint tar"*)
    [ "$FAKE_FAIL" = run ] && exit 1
    if [ "$FAKE_ARCHIVE" = truncated ]; then tar -czf - -C "$FAKE_DATA" . | head -c 40; else tar -czf - -C "$FAKE_DATA" .; fi ;;
  "compose run"*"--entrypoint sh"*)
    for last; do :; done
    script=$(printf '%s' "$last" | sed "s#/data#$FAKE_DATA#g")
    exec sh -c "$script" ;;
  "compose up"*)
    echo "commit=$RELAY_COMMIT" >> "$FAKE_LOG"
    ls -A "$RELAY_BUILD_CONTEXT" >> "$FAKE_LOG" ;;
  "image inspect"*) echo sha256:1 ;;
  "run "*"tunnel login") touch secrets/cert.pem ;;
  "run "*"tunnel create"*) echo '{"TunnelID":"0f0f0f0f-0000-4000-8000-000000000000"}' > secrets/tunnel_credentials.json ;;
  "run "*"tunnel route dns"*) [ "$FAKE_FAIL" = dns ] && { echo "An A, AAAA, or CNAME record with that host already exists." >&2; exit 1; } ;;
esac
exit 0
`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "relay-deploy-"));
  const bin = join(dir, "bin");
  const deploy = join(dir, "repo", "deploy");
  const data = join(dir, "data");
  await mkdir(bin);
  await mkdir(deploy, { recursive: true });
  await mkdir(data);
  for (const file of ["backup.sh", "restore.sh", "tunnel-setup.sh", "up.sh", "compose.yaml", ".gitignore"])
    await copyFile(join(DEPLOY, file), join(deploy, file));
  await writeFile(join(bin, "docker"), FAKE_DOCKER);
  await writeFile(join(bin, "sudo"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "docker"), 0o755);
  await chmod(join(bin, "sudo"), 0o755);
  const log = join(dir, "docker.log");
  await writeFile(log, "");
  const run = (script: string, env: Record<string, string> = {}, input = "") =>
    spawnSync("sh", [join(deploy, script), ...(env.ARG ? [env.ARG] : [])], {
      cwd: deploy,
      input,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_DATA: data, ...env },
    });
  return {
    dir,
    deploy,
    data,
    run,
    calls: () => readFile(log, "utf8"),
    backups: async () => (await readdir(join(deploy, "backups"))).sort(),
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

test("a backup is checked, old ones beyond the newest 7 go, and a failed one is never silent", async (t) => {
  const s = await setup();
  t.after(s.done);
  await writeFile(join(s.data, "relay.sqlite"), "database");
  await mkdir(join(s.deploy, "backups"));
  const old = Array.from({ length: 8 }, (_, i) => `relay-2020-01-0${i + 1}-0300.tar.gz`);
  for (const name of old) await writeFile(join(s.deploy, "backups", name), "old");

  // Cut short (a full disk): refused, reported, Relay started again, nothing old deleted.
  let result = s.run("backup.sh", { FAKE_ARCHIVE: "truncated" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Backup FAILED/);
  assert.deepEqual(await s.backups(), [...old, "LAST-BACKUP-FAILED"].sort());
  assert.match(await s.calls(), /compose start relay/);

  result = s.run("backup.sh", { FAKE_FAIL: "run" });
  assert.notEqual(result.status, 0);
  assert.ok((await s.backups()).includes("LAST-BACKUP-FAILED"));

  // A good one clears the warning and keeps the newest 7, itself included.
  result = s.run("backup.sh");
  assert.equal(result.status, 0, result.stderr);
  const kept = await s.backups();
  assert.equal(kept.length, 7);
  assert.ok(!kept.includes("LAST-BACKUP-FAILED"));
  assert.deepEqual(kept.slice(0, 6), old.slice(2));
  assert.match(kept[6], /^relay-\d{4}-\d\d-\d\d-\d{4}\.tar\.gz$/);

  result = s.run("backup.sh", { RELAY_BACKUPS_KEEP: "2" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await s.backups()).length, 2);
});

test("restore checks the backup before touching Relay's data, and swaps it in only once unpacked", async (t) => {
  const s = await setup();
  t.after(s.done);
  await writeFile(join(s.data, "relay.sqlite"), "current");
  await writeFile(join(s.data, "secret.key"), "current key");
  const bad = join(s.dir, "bad.tar.gz");
  await writeFile(bad, "not a backup");
  let result = s.run("restore.sh", { ARG: bad }, "restore\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /damaged or isn't a backup/);
  assert.equal(await s.calls(), "", "docker isn't touched");

  // A real archive, but not Relay's.
  const other = join(s.dir, "other");
  await mkdir(other);
  await writeFile(join(other, "photo.jpg"), "x");
  execFileSync("tar", ["-czf", join(s.dir, "other.tar.gz"), "-C", other, "."]);
  result = s.run("restore.sh", { ARG: join(s.dir, "other.tar.gz") }, "restore\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isn't a Relay backup/);
  assert.equal(await readFile(join(s.data, "relay.sqlite"), "utf8"), "current");

  const backup = join(s.dir, "backup");
  await mkdir(join(backup, "blobs"), { recursive: true });
  await writeFile(join(backup, "relay.sqlite"), "restored");
  await writeFile(join(backup, "blobs", "a"), "file");
  execFileSync("tar", ["-czf", join(s.dir, "good.tar.gz"), "-C", backup, "."]);
  result = s.run("restore.sh", { ARG: join(s.dir, "good.tar.gz") }, "restore\n");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(s.data)).sort(), ["blobs", "relay.sqlite"]);
  assert.equal(await readFile(join(s.data, "relay.sqlite"), "utf8"), "restored");
  assert.match(await s.calls(), /compose start relay/);
});

test("tunnel setup never leaves Cloudflare's account certificate behind, even when it fails", async (t) => {
  const s = await setup();
  t.after(s.done);
  await writeFile(join(s.deploy, ".env"), "RELAY_ORIGIN=https://relay.example.test\nTUNNEL_ID=\n");
  const result = s.run("tunnel-setup.sh", { FAKE_FAIL: "dns" });
  assert.notEqual(result.status, 0);
  assert.match(await s.calls(), /tunnel login/);
  assert.ok(!existsSync(join(s.deploy, "secrets", "cert.pem")), "cert.pem was deleted");
  assert.ok(existsSync(join(s.deploy, "secrets", "tunnel_credentials.json")));
});

test("up.sh builds from exactly the commit: files that aren't part of it stay out of the image", async (t) => {
  const s = await setup();
  t.after(s.done);
  const repo = join(s.dir, "repo");
  await writeFile(join(repo, "Dockerfile"), "FROM scratch\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      encoding: "utf8",
    });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "--no-gpg-sign", "-m", "deploy");
  await writeFile(join(repo, "stray.txt"), "not committed");
  await writeFile(join(s.deploy, ".env"), "RELAY_ORIGIN=https://relay.example.test\nTUNNEL_ID=x\n");
  await mkdir(join(s.deploy, "secrets"));
  await writeFile(join(s.deploy, "secrets", "tunnel_credentials.json"), "{}");

  const result = s.run("up.sh");
  assert.equal(result.status, 0, result.stderr);
  const calls = await s.calls();
  const built = calls.split("\n");
  assert.ok(built.includes(`commit=${git("rev-parse", "HEAD").trim()}`));
  assert.ok(built.includes("Dockerfile") && built.includes("deploy"), calls);
  assert.ok(!built.includes("stray.txt"), "an untracked file reached the build");
});

test("Relay's networks and egress proxy keep it away from the machine and from look-alike names", async () => {
  const compose = await read("deploy/compose.yaml");
  const networks = compose.slice(compose.indexOf("\nnetworks:\n"), compose.indexOf("\nvolumes:\n"));
  for (const network of ["edge", "egress"]) {
    const block = networks.match(new RegExp(`\\n  ${network}:\\n((?:    .*\\n)+)`))?.[1] ?? "";
    assert.match(block, /internal: true/, network);
    assert.match(block, /com\.docker\.network\.bridge\.inhibit_ipv4: "true"/, network);
  }

  const squid = (await read("deploy/egress/squid.conf")).split("\n").filter((line) => line && !line.startsWith("#"));
  assert.ok(
    squid.some((line) => /^acl push_services dstdomain -n /.test(line)),
    "no reverse-DNS matching",
  );
  const rules = squid.filter((line) => line.startsWith("http_access "));
  assert.ok(
    rules.indexOf("http_access deny !push_services") < rules.indexOf("http_access deny private_dst") &&
      rules.indexOf("http_access deny !push_services") >= 0,
    "names are refused before any address lookup",
  );
  const privateRanges = squid
    .filter((line) => line.startsWith("acl private_dst dst "))
    .flatMap((line) => line.split(/\s+/).slice(3));
  for (const range of ["10.0.0.0/8", "64:ff9b::/96", "64:ff9b:1::/48", "2002::/16"])
    assert.ok(privateRanges.includes(range), range);

  const dockerfile = await read("Dockerfile");
  const final = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  for (const tool of ["/usr/bin/bash", "/usr/bin/perl", "/usr/local/bin/corepack"])
    assert.ok(final.includes(tool), tool);
});
