// Event streams over a real socket, for tests of what a stream carries and when it ends.
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { Client, Instance } from "./harness.ts";

/**
 * An open event stream, collecting the events it has received. Uses node:http without an agent so
 * no pooled or speculative sockets outlive the test.
 */
export class Stream {
  readonly events: string[] = [];
  readonly status: number;
  private readonly req: ClientRequest;
  private readonly done: Promise<void>;
  private waiters: (() => void)[] = [];

  private constructor(req: ClientRequest, res: IncomingMessage) {
    this.req = req;
    this.status = res.statusCode ?? 0;
    this.done = this.read(res);
  }

  static open(base: string, path: string, client: Client, browser: string | null = client.tab) {
    const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (browser) path += `${path.includes("?") ? "&" : "?"}browser=${browser}`;
    return new Promise<Stream>((resolve, reject) => {
      const req = request(
        base + path,
        { agent: false, headers: { host: "relay.test", ...(cookie ? { cookie } : {}) } },
        (res) => resolve(new Stream(req, res)),
      );
      req.on("error", reject);
      req.end();
    });
  }

  private async read(res: IncomingMessage) {
    let buffer = "";
    try {
      for await (const chunk of res.setEncoding("utf8") as AsyncIterable<string>) {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          this.events.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
        for (const wake of this.waiters.splice(0)) wake();
      }
    } catch {
      // Destroyed by the test.
    }
    this.events.push("<closed>");
    for (const wake of this.waiters.splice(0)) wake();
  }

  async until(predicate: (events: string[]) => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.events)) {
      if (Date.now() > deadline) throw new Error(`Timed out; events so far: ${JSON.stringify(this.events)}`);
      await Promise.race([new Promise<void>((resolve) => this.waiters.push(resolve)), sleep(50)]);
    }
  }

  async close() {
    this.req.destroy();
    await this.done;
  }
}

export async function listen(instance: Instance) {
  return instance.app.listen({ port: 0, host: "127.0.0.1" });
}

export async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition not reached in time.");
    await sleep(25);
  }
}
