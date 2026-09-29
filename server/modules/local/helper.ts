// Runs the direct-transfer helper (local/main.ts) as a process of its own, so a failure in its
// native WebRTC library can't take Relay down, and starts it again whenever it stops.
import type { FastifyBaseLogger } from "fastify";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HelperMessage } from "../../../shared/local.ts";

const MAIN = fileURLToPath(new URL("../../../local/main.ts", import.meta.url));
/** Waits before starting a helper that stopped, longer while it keeps stopping. */
const RESTART_MS = [1000, 2000, 5000, 15_000, 60_000];
/** A helper that ran this long was running well: if it stops, the next start waits the least again. */
const STEADY_MS = 60_000;
/** How long a helper may take to close its connections when asked to stop. */
const STOP_MS = 5000;

export class LocalHelper {
  /** The private directory Relay and the helper share, once started. */
  dir: string | null = null;
  state: "starting" | "ready" | "down" = "starting";
  /** Why the helper can't run, when it said. */
  problem: string | null = null;
  /** How the last helper process ended. */
  lastExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  readonly port: number;
  private readonly log: FastifyBaseLogger;
  private child: ChildProcess | null = null;
  private restart: NodeJS.Timeout | undefined;
  private stops = 0;
  private stopping = false;

  constructor(port: number, log: FastifyBaseLogger) {
    this.port = port;
    this.log = log;
  }

  /** Creates the directory, in which Relay's socket must be served before `run`. */
  async prepare() {
    // Private to Relay's user: whoever can reach the sockets in it acts for any session.
    this.dir = await mkdtemp(join(tmpdir(), "relay-local-"));
    return this.dir;
  }

  run() {
    if (this.stopping || !this.dir) return;
    const started = Date.now();
    const child = fork(MAIN, [this.dir, String(this.port)], {
      // Only what the helper needs: never the flags Relay itself runs with, such as --watch.
      execArgv: [],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.child = child;
    this.state = "starting";
    child.on("message", (message: HelperMessage) => {
      if (message.type === "log") this.log[message.level]({ ...message.fields, source: "local" }, message.msg);
      else if (message.type === "ready") {
        this.state = "ready";
        this.problem = null;
        this.log.info(`Direct transfers are ready on UDP port ${this.port}.`);
      } else if (message.type === "failed") {
        this.problem = message.reason;
        this.log.error(`Direct transfers are unavailable: ${message.reason}`);
      }
    });
    // Only a helper that didn't start at all has no exit to follow.
    child.on("error", (error) => {
      if (child.pid === undefined) this.ended(child, started, { code: null, signal: null }, String(error));
    });
    child.once("exit", (code, signal) => this.ended(child, started, { code, signal }));
  }

  private ended(child: ChildProcess, started: number, exit: NonNullable<LocalHelper["lastExit"]>, error?: string) {
    if (this.child !== child) return;
    this.child = null;
    this.lastExit = exit;
    if (this.stopping) return;
    this.state = "down";
    if (Date.now() - started >= STEADY_MS) this.stops = 0;
    const wait = RESTART_MS[Math.min(this.stops++, RESTART_MS.length - 1)];
    this.log.warn(
      { ...exit, err: error },
      `The direct-transfer helper stopped; Relay starts it again in ${wait / 1000} seconds.`,
    );
    this.restart = setTimeout(() => this.run(), wait);
  }

  /** Stops the helper, letting it close its connections, and removes the directory. */
  async stop() {
    this.stopping = true;
    clearTimeout(this.restart);
    const child = this.child;
    if (child) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
      await exited;
      clearTimeout(kill);
      // One still starting ends at the signal itself, with nothing to close.
      const exit = this.lastExit;
      if (exit && exit.code !== 0 && exit.signal !== "SIGTERM")
        this.log.warn(exit, "The direct-transfer helper didn't stop cleanly.");
    }
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}
