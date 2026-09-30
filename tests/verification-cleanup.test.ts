import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { cleanUp, buildClient } from "../scripts/lib/verification.ts";

const AsyncFunction = (Object.getPrototypeOf(async () => {}) as { constructor: unknown }).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<void>;

// Execute the actual scripts' orchestration blocks with disposable resource/failure stand-ins.
// This checks scope and ordering; it does not substitute for real Docker/browser acceptance.
test("Compose cleanup attempts later resources and preserves the primary error", async () => {
  const source = await readFile(new URL("../scripts/verify-compose.ts", import.meta.url), "utf8");
  const block = source.slice(source.lastIndexOf("} finally {") + "} finally {".length, source.lastIndexOf("}"));
  const invoke = new AsyncFunction(
    "projects",
    "containers",
    "docker",
    "network",
    "tunnel",
    "rm",
    "temp",
    "nodeDataChannel",
    "cleanUp",
    "process",
    block,
  );
  const calls: string[] = [],
    reports: string[] = [];
  const state = { exitCode: 0 };
  const primary = new Error("primary verification failure");
  const guarded = async () => {
    try {
      throw primary;
    } finally {
      await invoke(
        [
          () => {
            calls.push("project1");
            throw new Error("down failed");
          },
          () => calls.push("project2"),
        ],
        ["connector", "stranger"],
        (...args: string[]) => {
          calls.push(args.join(" "));
          if (args[2] === "connector") throw new Error("remove failed");
        },
        true,
        "synthetic-network",
        () => calls.push("directory"),
        "synthetic-directory",
        { cleanup: () => calls.push("native") },
        (actions: Parameters<typeof cleanUp>[0]) => cleanUp(actions, (name) => reports.push(name)),
        state,
      );
    }
  };
  await assert.rejects(guarded, (error) => error === primary);
  assert.deepEqual(calls, [
    "project1",
    "project2",
    "rm -f connector",
    "rm -f stranger",
    "network rm synthetic-network",
    "directory",
    "native",
  ]);
  assert.equal(reports.length, 2);
  assert.equal(state.exitCode, 1);
});

test("screenshot startup/capture/stop failures retain the primary error and clean directories/browser", async () => {
  const source = await readFile(new URL("../scripts/screenshots.ts", import.meta.url), "utf8");
  const block = stripTypeScriptTypes(source.slice(source.lastIndexOf("await mkdir(out,")), { mode: "strip" });
  const names = [
    "mkdir",
    "mkdtemp",
    "rm",
    "join",
    "tmpdir",
    "out",
    "chromium",
    "startServer",
    "freePort",
    "Session",
    "LOCAL_PASSWORD",
    "capture",
    "seed",
    "hero",
    "console",
    "process",
    "cleanUp",
  ];
  const invoke = new AsyncFunction(...names, block);
  for (const mode of ["startup", "capture", "stop"]) {
    const root = await mkdtemp(join(tmpdir(), "relay-screenshot-cleanup-"));
    const directories: string[] = [],
      calls: string[] = [],
      reports: string[] = [];
    const primary = new Error(`${mode} failure`),
      state = { exitCode: 0 };
    try {
      const run = () =>
        invoke(
          mkdir,
          async () => {
            const dir = await mkdtemp(join(root, "data-"));
            directories.push(dir);
            return dir;
          },
          rm,
          join,
          () => root,
          join(root, "output"),
          {
            launch: () => ({
              close: () => {
                calls.push("browser");
                throw new Error("browser close failed");
              },
            }),
          },
          () => {
            if (mode === "startup") throw primary;
            return {
              origin: "synthetic",
              stop: () => {
                calls.push("server");
                throw new Error("stop failed");
              },
            };
          },
          () => 0,
          class {
            async signIn() {}
          },
          "synthetic password",
          async (_browser: unknown, _origin: string, scheme: string) => {
            if (mode === "capture") throw primary;
            await writeFile(join(root, "output", `link-${scheme}.png`), "synthetic");
            await writeFile(join(root, "output", `share-mobile-${scheme}.png`), "synthetic");
          },
          () => ({}),
          () => {},
          { log: () => {} },
          state,
          (actions: Parameters<typeof cleanUp>[0]) => cleanUp(actions, (name) => reports.push(name)),
        );
      if (mode !== "stop") await assert.rejects(run, (error) => error === primary);
      else await run();
      assert(calls.includes("browser"));
      if (mode !== "startup") assert(calls.includes("server"));
      for (const dir of directories) await assert.rejects(access(dir), { code: "ENOENT" });
      assert.equal(state.exitCode, 1);
      assert(reports.length > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("browser-scale cleanup continues after browser and server failures", async () => {
  const source = await readFile(new URL("../scripts/verify-browser-scale.ts", import.meta.url), "utf8");
  const block = source.slice(source.lastIndexOf("} finally {") + "} finally {".length, source.lastIndexOf("}"));
  const invoke = new AsyncFunction("browser", "server", "rm", "work", "process", "cleanUp", block);
  const calls: string[] = [],
    state = { exitCode: 1 };
  await invoke(
    {
      close: () => {
        calls.push("browser");
        throw new Error("close failed");
      },
    },
    {
      stop: () => {
        calls.push("server");
        throw new Error("stop failed");
      },
    },
    () => calls.push("directory"),
    "synthetic",
    state,
    (actions: Parameters<typeof cleanUp>[0]) => cleanUp(actions, () => {}),
  );
  assert.deepEqual(calls, ["browser", "server", "directory"]);
  assert.equal(state.exitCode, 1);
});

test("Vite fixture build reports child errors and kills a hung direct child at its deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-build-deadline-"));
  try {
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    const executable = join(root, "node_modules", ".bin", "vite");
    await writeFile(executable, `#!${process.execPath}\nconsole.error('synthetic build error');process.exit(7);\n`, {
      mode: 0o755,
    });
    assert.throws(() => buildClient(root, join(root, "dist")), /exit 7.*\nsynthetic build error/);
    const pidFile = join(root, "child.pid");
    await writeFile(
      executable,
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`,
      { mode: 0o755 },
    );
    const started = performance.now();
    assert.throws(() => buildClient(root, join(root, "dist"), 1000), /ETIMEDOUT/);
    assert(performance.now() - started < 5000);
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await rm(executable);
    assert.throws(() => buildClient(root, join(root, "dist")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
