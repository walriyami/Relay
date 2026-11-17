import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "../shared/api.ts";
import { admin, Client, start } from "./support/harness.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" });

/** A copy of the two build files and package.json, so stamping never writes into the checkout. */
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "relay-build-"));
  await mkdir(join(dir, "server"));
  for (const file of ["server/build-info.ts", "server/build-stamp.ts", "package.json"])
    await copyFile(join(REPO, file), join(dir, file));
  return dir;
}

test("health and Admin say which commit is running, and a development copy says it has none", async () => {
  const instance = await start();
  try {
    const health = await new Client(instance).call(api.health);
    const { version } = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")) as { version: string };
    assert.equal(health.version, version);
    // Tests run from a working tree: there is no commit to report unless an image build stamped one.
    assert.equal(health.commit, null);
    const overview = await (await admin(instance)).call(api.admin.overview);
    assert.deepEqual(overview.build, { version, commit: null, committed: null });
  } finally {
    await instance.close();
  }
});

test("an image build stops when it can't name the commit it holds", async () => {
  const dir = await scratch();
  try {
    for (const args of [[], [""], ["main"], ["d24a512"]]) {
      const run = spawnSync(process.execPath, ["server/build-stamp.ts", ...args], { cwd: dir, encoding: "utf8" });
      assert.equal(run.status, 1, `refused ${JSON.stringify(args)}`);
      assert.match(run.stderr, /walctl deploy relay-production --commit main/);
    }
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const run = spawnSync(process.execPath, ["server/build-stamp.ts", commit], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "server/build.json"), "utf8")), { commit, committed: null });
    const shown = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", 'console.log(JSON.stringify((await import("./server/build-info.ts")).build))'],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(JSON.parse(shown.stdout).commit, commit);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a walctl deploy by commit stamps the commit by itself", { skip: !hasGit() }, async () => {
  // walctl builds `--commit` deploys from `git archive <ref> <inputs>`; git fills build-info.ts's
  // placeholders because .gitattributes marks it export-subst.
  const head = git("rev-parse", "HEAD").trim();
  if (!git("ls-tree", "--name-only", "HEAD", "server/build-info.ts", ".gitattributes").includes(".gitattributes"))
    return; // An uncommitted first version of this feature: nothing archived to check yet.
  const archived = execFileSync("git", ["archive", "--format=tar", "HEAD", "server", "package.json"], { cwd: REPO });
  const dir = await mkdtemp(join(tmpdir(), "relay-archive-"));
  try {
    execFileSync("tar", ["-x", "-C", dir], { input: archived });
    const run = spawnSync(process.execPath, ["server/build-stamp.ts"], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const stamp = JSON.parse(await readFile(join(dir, "server/build.json"), "utf8")) as { commit: string };
    assert.equal(stamp.commit, head);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function hasGit() {
  try {
    git("rev-parse", "--git-dir");
    return true;
  } catch {
    return false;
  }
}
