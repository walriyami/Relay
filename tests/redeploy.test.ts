import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const script = await readFile(new URL("../scripts/redeploy.sh", import.meta.url), "utf8");

// Routing and filesystem fixtures only: this stub does not establish Docker orchestration.
const dockerStub = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const statePath = process.env.REDEPLOY_FIXTURE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.calls.push(args);
fs.writeFileSync(statePath, JSON.stringify(state));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const fail = () => process.exit(1);
if (args[0] === 'info') process.exit(0);
if (args[0] === 'compose') {
  if (args[1] === 'config') console.log(args[2] === '--images' ? 'synthetic:fixture' : 'name: synthetic');
  if (args[1] === 'ps') console.log('synthetic-container');
  if (args[1] === 'down') {state.running = false; save();}
  if (args[1] === 'up') {state.running = true; save();}
  process.exit(0);
}
if (args[0] === 'volume') {
  const name = args.at(-1);
  if (args[1] === 'inspect') {
    const v = state.volumes[name]; if (!v) fail();
    if (args.includes('-f')) console.log([v.driver || 'local', v.options || 0, v.mountpoint || v.path].join('|'));
  }
  if (args[1] === 'create') {
    const dir = path.join(path.dirname(statePath), 'volumes', name);
    fs.mkdirSync(dir, {recursive:true});
    state.volumes[name] ||= {path:dir}; save();
  }
  if (args[1] === 'rm') {fs.rmSync(state.volumes[name].path, {recursive:true,force:true}); delete state.volumes[name]; save();}
  if (args[1] === 'ls') console.log(Object.keys(state.volumes).filter(n => n.startsWith('synthetic_relay-data-saved-')).join('\\n'));
  process.exit(0);
}
if (args[0] === 'inspect') {
  const format = args[args.indexOf('-f')+1];
  console.log(format.includes('Health') ? 'healthy' : format.includes('Restart') ? '0' : format.includes('.Image') ? 'synthetic-old-image' : 'running');
  process.exit(0);
}
if (args[0] === 'run') {
  if (args.includes('cat')) {console.log('synthetic schema'); process.exit(0);}
  const mounts = args.filter((v,i) => args[i-1] === '-v');
  const from = mounts.find(m => m.includes(':/from:')).split(':')[0];
  const to = mounts.find(m => m.endsWith(':/to')).split(':')[0];
  const src = state.volumes[from].path, dst = state.volumes[to].path;
  for (const name of fs.readdirSync(dst)) fs.rmSync(path.join(dst,name), {recursive:true,force:true});
  if (state.failCopyFrom === from) fail();
  fs.cpSync(src,dst,{recursive:true}); process.exit(0);
}
if (['build','tag','image'].includes(args[0])) process.exit(0);
console.error('Unexpected Docker command', args); fail();
`;

type Volume = { path: string; driver?: string; options?: number; mountpoint?: string };
type State = { volumes: Record<string, Volume>; calls: string[][]; running: boolean; failCopyFrom?: string };

async function fixture(run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture();
  try {
    await run(f);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-redeploy-"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "scripts/redeploy.sh"), script);
  await writeFile(join(root, "bin/docker"), dockerStub, { mode: 0o755 });
  const statePath = join(root, "state.json");
  const datePath = join(root, "fixture-date");
  await writeFile(datePath, "20010101-000000\n");
  await writeFile(join(root, "bin/date"), '#!/bin/sh\ncat "$REDEPLOY_FIXTURE_DATE"\n', { mode: 0o755 });
  const state: State = { volumes: {}, calls: [], running: true };
  const persist = () => writeFile(statePath, JSON.stringify(state));
  const addVolume = async (name: string, contents: string) => {
    const path = join(root, "volumes", name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "synthetic.txt"), contents);
    state.volumes[name] = { path };
    await persist();
  };
  await addVolume("synthetic_relay-data", "original synthetic data");
  await addVolume("saved-source", "restored synthetic data");
  for (const args of [
    ["init", "-q"],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "--allow-empty", "-qm", "fixture"],
  ]) {
    assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
  }
  const read = async () => JSON.parse(await readFile(statePath, "utf8")) as State;
  const execute = (args: string[], helper?: string) => {
    const env = {
      ...process.env,
      PATH: `${join(root, "bin")}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      REDEPLOY_FIXTURE: statePath,
      REDEPLOY_FIXTURE_DATE: datePath,
    };
    return spawnSync("bash", helper ? ["-c", helper] : ["scripts/redeploy.sh", "--from", "working", "-y", ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
  };
  return { root, state, persist, addVolume, read, execute, datePath };
}

const mutated = (calls: string[][]) =>
  calls.filter(
    (a) =>
      a[0] === "build" ||
      a[0] === "tag" ||
      a[0] === "run" ||
      (a[0] === "compose" && ["down", "up"].includes(a[1])) ||
      (a[0] === "volume" && ["create", "rm"].includes(a[1])),
  );

test("redeploy rejects explicit self-restore before mutation and preserves service/data", async () => {
  await fixture(async (f) => {
    const original = await readFile(join(f.state.volumes["synthetic_relay-data"].path, "synthetic.txt"));
    const result = f.execute(["--data", "restore=synthetic_relay-data"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /onto itself/);
    const after = await f.read();
    assert.equal(after.running, true);
    assert.deepEqual(mutated(after.calls), []);
    assert.deepEqual(await readFile(join(after.volumes["synthetic_relay-data"].path, "synthetic.txt")), original);
  });
});

test("copy_volume rejects self-copy before volume creation", async () => {
  await fixture(async (f) => {
    const helper = script.slice(script.indexOf("volume_path()"), script.indexOf("schema_of()"));
    const result = f.execute(
      [],
      `set -euo pipefail\nfail() { echo "$*" >&2; exit 1; }\nvolume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }\n${helper}\ncopy_volume same same`,
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /onto itself/);
    assert.deepEqual((await f.read()).calls, []);
  });
});

test("redeploy rejects ambiguous drivers, bind options and overlapping paths before mutation", async () => {
  for (const kind of ["plugin", "bind", "same", "parent", "child"])
    await fixture(async (f) => {
      const source = f.state.volumes["saved-source"],
        active = f.state.volumes["synthetic_relay-data"];
      if (kind === "plugin") source.driver = "synthetic-plugin";
      if (kind === "bind") source.options = 3;
      if (kind === "same") source.mountpoint = active.path;
      if (kind === "parent") source.mountpoint = join(active.path, "..");
      if (kind === "child") source.mountpoint = join(active.path, "nested");
      await f.persist();
      const result = f.execute(["--data", "restore=saved-source"]);
      assert.equal(result.status, 1, kind);
      assert.deepEqual(mutated((await f.read()).calls), [], kind);
    });
});

test("distinct restore succeeds while preserving source and saved original; latest resolves", async () => {
  for (const latest of [false, true])
    await fixture(async (f) => {
      if (latest) await f.addVolume("synthetic_relay-data-saved-20000101-000000", "restored synthetic data");
      const source = latest ? "synthetic_relay-data-saved-20000101-000000" : "saved-source";
      const result = f.execute(["--data", `restore=${latest ? "latest" : source}`]);
      assert.equal(result.status, 0, result.stderr);
      const after = await f.read();
      assert.equal(after.running, true);
      assert.equal(
        await readFile(join(after.volumes["synthetic_relay-data"].path, "synthetic.txt"), "utf8"),
        "restored synthetic data",
      );
      assert.equal(
        await readFile(join(after.volumes[source].path, "synthetic.txt"), "utf8"),
        "restored synthetic data",
      );
      const saved = Object.entries(after.volumes).find(
        ([name]) => name.startsWith("synthetic_relay-data-saved-") && name !== source,
      )!;
      assert.equal(await readFile(join(saved[1].path, "synthetic.txt"), "utf8"), "original synthetic data");
    });
});

test("failed restore retains a usable backup and reports stopped-service recovery", async () => {
  await fixture(async (f) => {
    f.state.failCopyFrom = "saved-source";
    await f.persist();
    const result = f.execute(["--data", "restore=saved-source"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Do not start it with the partially restored data/);
    assert.match(result.stderr, /--from <matching-ref> --data restore=synthetic_relay-data-saved-/);
    const after = await f.read();
    assert.equal(after.running, false);
    const saved = Object.entries(after.volumes).find(([name]) => name.startsWith("synthetic_relay-data-saved-"))!;
    assert.equal(await readFile(join(saved[1].path, "synthetic.txt"), "utf8"), "original synthetic data");
    assert.equal(
      await readFile(join(after.volumes["saved-source"].path, "synthetic.txt"), "utf8"),
      "restored synthetic data",
    );
    // Retry recovery using the retained backup, not the partially written active directory.
    f.state.volumes = after.volumes;
    f.state.calls = after.calls;
    f.state.running = after.running;
    delete f.state.failCopyFrom;
    await f.persist();
    await writeFile(f.datePath, "20010101-000001\n");
    const recovery = f.execute(["--data", `restore=${saved[0]}`]);
    assert.equal(recovery.status, 0, recovery.stderr);
    const recovered = await f.read();
    assert.equal(recovered.running, true);
    assert.equal(
      await readFile(join(recovered.volumes["synthetic_relay-data"].path, "synthetic.txt"), "utf8"),
      "original synthetic data",
    );
    assert.equal(await readFile(join(saved[1].path, "synthetic.txt"), "utf8"), "original synthetic data");
  });
});

test("keep/save/wipe retain their routing; no saved latest fails without mutation", async () => {
  for (const mode of ["keep", "save", "wipe", "restore=latest"])
    await fixture(async (f) => {
      const result = f.execute(["--data", mode]);
      const after = await f.read();
      if (mode === "restore=latest") {
        assert.equal(result.status, 1);
        assert.deepEqual(mutated(after.calls), []);
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      assert.equal(after.running, true);
      const stopped = after.calls.some((a) => a[0] === "compose" && a[1] === "down");
      assert.equal(stopped, mode !== "keep");
      if (mode === "keep")
        assert.equal(
          await readFile(join(after.volumes["synthetic_relay-data"].path, "synthetic.txt"), "utf8"),
          "original synthetic data",
        );
      if (mode === "save") {
        const saved = Object.entries(after.volumes).find(([name]) => name.startsWith("synthetic_relay-data-saved-"))!;
        assert.equal(await readFile(join(saved[1].path, "synthetic.txt"), "utf8"), "original synthetic data");
        assert(after.calls.some((a) => a[0] === "run"));
      }
      if (mode === "wipe")
        assert.equal(
          after.calls.some((a) => a[0] === "run" && a.includes("sh")),
          false,
        );
    });
});

test("saved-volume collision cannot overwrite an existing backup", async () => {
  await fixture(async (f) => {
    await f.addVolume("synthetic_relay-data-saved-20010101-000000", "previous backup");
    const result = f.execute(["--data", "save"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already exists/);
    const after = await f.read();
    assert.equal(
      after.calls.some((a) => a[0] === "run" && a.includes("sh")),
      false,
    );
    assert.equal(
      await readFile(join(after.volumes["synthetic_relay-data-saved-20010101-000000"].path, "synthetic.txt"), "utf8"),
      "previous backup",
    );
    assert.equal(
      await readFile(join(after.volumes["synthetic_relay-data"].path, "synthetic.txt"), "utf8"),
      "original synthetic data",
    );
  });
});

test("latest is checked for ambiguous backing before mutation", async () => {
  await fixture(async (f) => {
    const name = "synthetic_relay-data-saved-20000101-000000";
    await f.addVolume(name, "synthetic alias");
    f.state.volumes[name].options = 3;
    await f.persist();
    const result = f.execute(["--data", "restore=latest"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not an ordinary Docker-managed local volume/);
    const after = await f.read();
    assert.equal(after.running, true);
    assert.deepEqual(mutated(after.calls), []);
  });
});

test("backup copy failure preserves the original and never attempts restore", async () => {
  await fixture(async (f) => {
    f.state.failCopyFrom = "synthetic_relay-data";
    await f.persist();
    const result = f.execute(["--data", "restore=saved-source"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Backup failed; original data remains/);
    const after = await f.read();
    assert.equal(after.running, false);
    assert.equal(
      await readFile(join(after.volumes["synthetic_relay-data"].path, "synthetic.txt"), "utf8"),
      "original synthetic data",
    );
    assert.equal(after.calls.filter((a) => a[0] === "run" && a.includes("sh")).length, 1);
  });
});
