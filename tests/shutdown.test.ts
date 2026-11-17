// Stopping Relay for a restart or update takes seconds, even with a download nobody is reading.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request, type IncomingMessage } from "node:http";
import { api, urls } from "../shared/api.ts";
import { shutdown } from "../server/shutdown.ts";
import { member, send, start } from "./support/harness.ts";
import { listen } from "./support/event-stream.ts";

test("a stalled download is cut off a few seconds into shutdown instead of holding it open", async () => {
  const instance = await start();
  let response: IncomingMessage | undefined;
  try {
    const base = await listen(instance);
    const client = await member(instance, "vic");
    const { created } = await send(client, [{ path: "big.bin", data: Buffer.alloc(32 * 1024 ** 2, 1) }]);
    const item = await client.call(api.items.get, { params: { id: created.itemId } });
    const node = item.nodes.find((n) => n.name === "big.bin")!;
    const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    // A phone on a weak connection: the download starts, then nothing more is read.
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        base + urls.nodeContent(node.id),
        { agent: false, headers: { host: "relay.test", cookie } },
        resolve,
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(response.statusCode, 200);
    response.pause();

    const started = Date.now();
    await shutdown(instance.app, 300);
    const took = Date.now() - started;
    assert.ok(took < 3_000, `shutdown took ${took} ms`);
    // The download was cut short; the browser continues it with a Range request after the restart.
    let received = 0;
    response.on("data", (chunk: Buffer) => (received += chunk.length));
    response.resume();
    await new Promise((resolve) => response!.once("close", resolve));
    assert.ok(received < 32 * 1024 ** 2);
  } finally {
    response?.destroy();
    await instance.close();
  }
});
