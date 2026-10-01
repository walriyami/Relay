// Small failure-handling helpers shared by disposable verification scripts.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

type Cleanup = { name: string; run: () => unknown };

/** Reports failures without throwing over the primary error, and attempts every cleanup. */
export async function cleanUp(
  actions: Cleanup[],
  report: (name: string, error: unknown) => void = (name, error) => console.error(`Cleanup failed (${name}):`, error),
): Promise<number> {
  let failures = 0;
  for (const action of actions) {
    try {
      await action.run();
    } catch (error) {
      failures++;
      report(action.name, error);
    }
  }
  return failures;
}

/** Builds only the browser fixture; a stuck Vite child cannot outlive the build deadline. */
export function buildClient(repo: string, outDir: string, timeoutMs = 120_000) {
  const built = spawnSync(
    join(repo, "node_modules", ".bin", "vite"),
    ["build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"],
    {
      cwd: repo,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    },
  );
  if (built.error || built.status !== 0)
    throw new Error(
      `vite build failed: ${built.error?.message ?? `exit ${built.status}, signal ${built.signal}`}\n${built.stderr ?? ""}`,
      {
        cause: built.error,
      },
    );
}
