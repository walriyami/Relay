import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
import { deviceContext } from "./helpers";
import type { Sink } from "../../client/lib/nearby/sink";

declare global {
  interface Window {
    closeGate: { held: boolean; release: () => void };
    sinkFixture: {
      sink: Sink;
      held: boolean;
      release: () => void;
      finish: Promise<string>;
      discards: Promise<void>[];
    };
  }
}

test.use({ launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] } });

async function fixture(page: Page) {
  // Load the actual sink implementation, with the project's compiler, under the same origin.
  for (const name of ["sink", "zip"]) {
    const source = await readFile(new URL(`../../client/lib/nearby/${name}.ts`, import.meta.url), "utf8");
    const { code } = await transformWithEsbuild(source, `${name}.ts`);
    await page.route(`**/__sink-test/${name}*`, (route) =>
      route.fulfill({ contentType: "text/javascript", body: code }),
    );
  }
  await page.goto("/");
  test.skip(
    !(await page.evaluate(
      () =>
        !!navigator.storage?.getDirectory &&
        !!navigator.locks &&
        typeof FileSystemFileHandle !== "undefined" &&
        "createWritable" in FileSystemFileHandle.prototype,
    )),
    "Requires OPFS and Web Locks",
  );
}

async function files(page: Page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle("relay-nearby");
    const entries: number[] = [];
    const entriesOf = (directory: FileSystemDirectoryHandle) =>
      (
        directory as unknown as { entries(): AsyncIterable<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> }
      ).entries();
    for await (const [, folder] of entriesOf(base)) {
      if (folder.kind !== "directory") continue;
      for await (const [, file] of entriesOf(folder)) {
        if (file.kind === "file") entries.push((await file.getFile()).size);
      }
    }
    return entries;
  });
}

test("discard waits for OPFS finalization and cannot publish a cancelled file", async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const path = "/__sink-test/sink.js";
    const { openSink } = (await import(path)) as { openSink: () => Promise<Sink> };
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the original handle via apply.
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
      const stream = await create.apply(this, args);
      const close = stream.close.bind(stream);
      stream.close = async () => {
        window.sinkFixture.held = true;
        await held;
        await close();
      };
      return stream;
    };
    const sink = await openSink();
    window.sinkFixture = { sink, held: false, release, finish: Promise.resolve(""), discards: [] };
    await sink.write(new Uint8Array(2 * 1024 * 1024 + 17).fill(73));
    window.sinkFixture.finish = sink.finish("application/octet-stream", "synthetic.bin", 0).then(
      () => "published",
      (error: Error) => error.name,
    );
  });
  await expect.poll(() => page.evaluate(() => window.sinkFixture.held)).toBe(true);
  await page.evaluate(() => {
    const f = window.sinkFixture;
    f.discards = [f.sink.discard(), f.sink.discard()];
    f.release();
  });
  const result = await page.evaluate(async () => {
    const f = window.sinkFixture;
    await Promise.all(f.discards);
    return f.finish;
  });
  expect(result).toBe("AbortError");
  expect(await files(page)).toEqual([]);
  await page.evaluate(() => window.sinkFixture.sink.discard());
  expect(await files(page)).toEqual([]);
});

test("completed OPFS file preserves bytes until idempotent discard", async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const path = "/__sink-test/sink.js";
    const { openSink } = (await import(path)) as { openSink: () => Promise<Sink> };
    const sink = await openSink();
    const expected = new Uint8Array(2 * 1024 * 1024 + 17).fill(83);
    await sink.write(expected.subarray(0, 1024 * 1024));
    await sink.write(expected.subarray(1024 * 1024));
    const file = await sink.finish("application/octet-stream", "synthetic.bin", 1234);
    const digest = async (bytes: BufferSource) =>
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).join(",");
    const result = {
      name: file.name,
      size: file.size,
      hash: await digest(await file.arrayBuffer()),
      expected: await digest(expected),
    };
    window.sinkFixture = { sink, held: false, release: () => {}, finish: Promise.resolve(""), discards: [] };
    return result;
  });
  expect(result.name).toBe("synthetic.bin");
  expect(result.hash).toBe(result.expected);
  expect(await files(page)).toEqual([result.size]);
  await page.evaluate(() => Promise.all([window.sinkFixture.sink.discard(), window.sinkFixture.sink.discard()]));
  expect(await files(page)).toEqual([]);
});

test("OPFS close errors and transient removal errors still clean up", async ({ page }) => {
  await fixture(page);
  const outcome = await page.evaluate(async () => {
    const path = "/__sink-test/sink.js";
    const { openSink } = (await import(path)) as { openSink: () => Promise<Sink> };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the original handle via apply.
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
      const stream = await create.apply(this, args);
      stream.close = () => Promise.reject(new Error("Injected close failure"));
      return stream;
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the original directory via apply.
    const remove = FileSystemDirectoryHandle.prototype.removeEntry;
    let failed = false;
    FileSystemDirectoryHandle.prototype.removeEntry = async function (...args) {
      if (!failed && args[0] === "1") {
        failed = true;
        throw new Error("Injected removal failure");
      }
      return remove.apply(this, args);
    };
    const sink = await openSink();
    await sink.write(new Uint8Array(2048));
    const error = await sink.finish("application/octet-stream", "synthetic.bin", 0).then(
      () => "published",
      (e: Error) => e.message,
    );
    await sink.discard();
    return { error, failed };
  });
  expect(outcome).toEqual({ error: "Injected close failure", failed: true });
  expect(await files(page)).toEqual([]);
});

test("Nearby cancellation during finalization cleans OPFS without a received result", async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Local ICE candidates require Chromium test flags");
  const sender = await deviceContext(browser, "Sink sender");
  const receiver = await deviceContext(browser, "Sink receiver");
  try {
    await receiver.context.addInitScript(() => {
      window.closeGate = { held: false, release: () => {} };
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the original handle via apply.
      const create = FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable = async function (...args) {
        const stream = await create.apply(this, args);
        const close = stream.close.bind(stream);
        stream.close = async () => {
          window.closeGate.held = true;
          await new Promise<void>((resolve) => (window.closeGate.release = resolve));
          await close();
        };
        return stream;
      };
    });
    await sender.page.goto("/nearby");
    await receiver.page.goto("/nearby");
    const target = sender.page
      .getByRole("complementary", { name: "Send to" })
      .getByRole("button", { name: receiver.name, exact: true });
    await expect(target).toHaveAccessibleDescription(/Ready/, { timeout: 20_000 });
    await sender.page.getByTestId("nearby-file-input").setInputFiles({
      name: "synthetic.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(2 * 1024 * 1024 + 17, 73),
    });
    await target.click();
    const received = receiver.page
      .getByRole("region", { name: "Transfers" })
      .getByRole("listitem", { name: `From ${sender.name}` });
    await expect.poll(() => receiver.page.evaluate(() => window.closeGate.held)).toBe(true);
    await received.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(received).toContainText("You stopped it.");
    await receiver.page.evaluate(() => window.closeGate.release());
    await expect.poll(() => files(receiver.page)).toEqual([]);
    await expect(received.getByRole("list", { name: "Files received" })).toHaveCount(0);
    await expect(received).not.toContainText("Received");
    const sent = sender.page
      .getByRole("region", { name: "Transfers" })
      .getByRole("listitem", { name: `To ${receiver.name}` });
    await expect(sent).toContainText("stopped it.");
  } finally {
    await sender.context.close();
    await receiver.context.close();
  }
});
