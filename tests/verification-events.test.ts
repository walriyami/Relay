import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { holdEvents, Session } from "../scripts/lib/relay.ts";

async function peer(t: TestContext, respond: (response: ServerResponse) => void) {
  let disconnected!: () => void;
  const closed = new Promise<void>((resolve) => (disconnected = resolve));
  let connected!: () => void;
  const opened = new Promise<void>((resolve) => (connected = resolve));
  const server = createServer((_request, response) => {
    response.on("close", disconnected);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    respond(response);
    connected();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { session: new Session(`http://127.0.0.1:${address.port}`), opened, closed };
}

test("deployment event admission times out and closes a buffered stream", { timeout: 5000 }, async (t) => {
  const { session, closed } = await peer(t, () => {});
  const stop = new AbortController();
  const watchdog = setTimeout(() => stop.abort(new Error("external watchdog")), 1000);
  t.after(() => clearTimeout(watchdog));
  await assert.rejects(holdEvents(session, stop.signal, 100), /event stream.*ready/i);
  assert.equal(stop.signal.aborted, false, "admission must fail before the external watchdog");
  await closed;
});

test("ready event clears only the admission deadline; caller still closes the stream", { timeout: 5000 }, async (t) => {
  const { session, closed } = await peer(t, (response) => {
    response.write(": keepalive\n\nevent: rea");
    setImmediate(() => response.write("dy\ndata: {}\n\n"));
  });
  const stop = new AbortController();
  t.after(() => stop.abort());
  await holdEvents(session, stop.signal, 1000);
  let ended = false;
  void closed.then(() => (ended = true));
  await delay(1200);
  assert.equal(ended, false, "an admitted stream must outlive its admission deadline");
  stop.abort();
  await closed;
});

test("caller cancellation interrupts event admission and releases its connection", { timeout: 5000 }, async (t) => {
  const { session, opened, closed } = await peer(t, () => {});
  const stop = new AbortController();
  const opening = holdEvents(session, stop.signal, 1000);
  const rejected = assert.rejects(opening);
  await opened;
  stop.abort();
  await rejected;
  await closed;
});
