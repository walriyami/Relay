import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { pdfAssets } from "./scripts/pdf-assets.ts";

/**
 * Stores Brotli (.br) and gzip (.gz) copies of the built text files, compressed once at the highest
 * settings, which Relay serves to browsers that accept them (see server/app.ts). Only copies that
 * save something are kept.
 */
function precompress(): Plugin {
  const brotli = promisify(brotliCompress);
  const gzipped = promisify(gzip);
  let outDir = "";
  return {
    name: "relay-precompress",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    async closeBundle() {
      const files = await readdir(outDir, { recursive: true, withFileTypes: true });
      await Promise.all(
        files
          .filter((f) => f.isFile() && /\.(html|js|mjs|css|svg|json|webmanifest|txt)$/.test(f.name))
          .map(async (f) => {
            const path = join(f.parentPath, f.name);
            const data = await readFile(path);
            if (data.length < 1024) return;
            const copies: [string, Buffer][] = [
              [
                ".br",
                await brotli(data, {
                  params: {
                    [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
                    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
                    [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
                  },
                }),
              ],
              [".gz", await gzipped(data, { level: constants.Z_BEST_COMPRESSION })],
            ];
            for (const [extension, copy] of copies)
              if (copy.length < data.length * 0.9) await writeFile(path + extension, copy);
          }),
      );
    },
  };
}

/** Recovery needs an import URL even when a browser omits failed Resource Timing entries. */
function lazyChunks(): Plugin {
  return {
    name: "relay-lazy-chunks",
    generateBundle(_, bundle) {
      const chunks = Object.values(bundle)
        .filter((file) => file.type === "chunk" && ["PdfReader", "SettingsPage", "AdminPage"].includes(file.name))
        .map((file) => [file.name, `/${file.fileName}`]);
      this.emitFile({
        type: "asset",
        fileName: "assets/page-chunks.json",
        source: JSON.stringify(Object.fromEntries(chunks)),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfAssets(), lazyChunks(), precompress()],
  server: {
    port: 5178,
    proxy: {
      "/api": "http://127.0.0.1:3090",
      "/uploads": "http://127.0.0.1:3090",
    },
  },
  build: {
    outDir: "dist",
    // The app shell is one ~160 kB (gzipped) bundle; rarely visited pages and pdf.js load on demand.
    // A page chunk must depend on the shell alone: WebKit can't retry one that failed to load when it
    // imports another chunk, so React and code shared by pages stay in the shell.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      // Dependencies ship some comments Rollup can't place; it drops them harmlessly, so don't report it.
      onwarn(warning, warn) {
        if (warning.code === "INVALID_ANNOTATION" && warning.id?.includes("/node_modules/")) return;
        warn(warning);
      },
    },
  },
});
