import { test as base, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
import type { Sink } from "../../client/lib/nearby/sink";

// Real native OPFS needs a persistent WebKit data store; ephemeral contexts use Blob fallback.
const test = base.extend({
  context: async ({ playwright, browserName, launchOptions, contextOptions }, use, testInfo) => {
    const profile = testInfo.outputPath("profile");
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...launchOptions.env }).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    for (const name of ["cache", "data", "config"]) {
      const path = testInfo.outputPath(name);
      await mkdir(path, { recursive: true });
      env[`XDG_${name.toUpperCase()}_HOME`] = path;
    }
    const context = await playwright[browserName].launchPersistentContext(profile, {
      ...launchOptions,
      ...contextOptions,
      env,
    });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
});

for (const storage of ["disk", "fallback"] as const) {
  test(`${storage} sink preserves byte views and frame payloads`, async ({ page }, testInfo) => {
    for (const name of ["sink", "zip"]) {
      const source = await readFile(new URL(`../../client/lib/nearby/${name}.ts`, import.meta.url), "utf8");
      const { code } = await transformWithEsbuild(source, `${name}.ts`);
      await page.route(`**/__byte-test/${name}*`, (route) =>
        route.fulfill({ contentType: "text/javascript", body: code }),
      );
    }
    await page.route("**/__byte-test/page", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>Sink integrity</title>" }),
    );
    await page.goto("/__byte-test/page");
    const results = await page.evaluate(async (storage) => {
      let failures = 0;
      if (storage === "fallback")
        Object.defineProperty(navigator.storage, "getDirectory", {
          configurable: true,
          value: () => {
            failures++;
            return Promise.reject(new DOMException("Synthetic unavailable storage", "UnknownError"));
          },
        });
      const path = "/__byte-test/sink.js";
      const { openSink } = (await import(path)) as { openSink: () => Promise<Sink> };
      const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, i) => i % 251);
      const frames = Array.from({ length: Math.ceil(bytes.length / 65536) }, (_, i) => {
        const payload = bytes.subarray(i * 65536, (i + 1) * 65536);
        const frame = new Uint8Array(12 + payload.length).fill(165);
        frame.set(payload, 12);
        return frame.subarray(12);
      });
      const cases = [
        { name: "nonzero offset", pieces: [bytes.subarray(13, 65549)], expected: bytes.subarray(13, 65549) },
        { name: "zero offset partial", pieces: [bytes.subarray(0, 65536)], expected: bytes.subarray(0, 65536) },
        { name: "shared backing", pieces: [bytes.subarray(0, 1048576), bytes.subarray(1048576)], expected: bytes },
        { name: "33 header-bearing frames", pieces: frames, expected: bytes },
      ];
      const hash = async (bytes: Uint8Array<ArrayBuffer>) =>
        Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).join(",");
      const diskFiles = async () => {
        const root = await navigator.storage.getDirectory();
        const folder = await root.getDirectoryHandle("relay-nearby");
        const entries = (dir: FileSystemDirectoryHandle) =>
          (dir as unknown as { values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle> }).values();
        const sizes: number[] = [];
        for await (const tab of entries(folder))
          if (tab.kind === "directory")
            for await (const file of entries(tab)) if (file.kind === "file") sizes.push((await file.getFile()).size);
        return sizes;
      };
      const results = [];
      for (const entry of cases) {
        const sink = await openSink();
        for (const piece of entry.pieces) await sink.write(piece);
        const file = await sink.finish("application/octet-stream", "bytes.bin", 1234);
        const result = {
          name: entry.name,
          size: file.size,
          expectedSize: entry.expected.length,
          written: sink.written,
          hash: await hash(new Uint8Array(await file.arrayBuffer())),
          expectedHash: await hash(entry.expected),
          diskSizes: storage === "disk" ? await diskFiles() : null,
          remaining: null as number[] | null,
        };
        await sink.discard();
        if (storage === "disk") result.remaining = await diskFiles();
        results.push(result);
      }
      return { results, failures };
    }, storage);
    await testInfo.attach("byte-results", { body: JSON.stringify(results), contentType: "application/json" });
    for (const result of results.results) {
      expect(result.size, result.name).toBe(result.expectedSize);
      expect(result.written, result.name).toBe(result.expectedSize);
      expect(result.hash, result.name).toBe(result.expectedHash);
      if (storage === "disk") {
        expect(result.diskSizes, result.name).toEqual([result.expectedSize]);
        expect(result.remaining, result.name).toEqual([]);
      }
    }
    expect(results.failures).toBe(storage === "fallback" ? 1 : 0);
  });
}
