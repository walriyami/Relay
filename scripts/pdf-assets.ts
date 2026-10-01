import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

/** Version-matched, same-origin PDF resources; only requested resources load in the browser. */
export function pdfAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const files = new Map<string, Buffer>();
  let prefix = "";
  return {
    name: "relay-pdf-assets",
    async config() {
      const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
      prefix = `assets/pdfjs-${version}/`;
      await Promise.all(
        ["cmaps", "standard_fonts", "iccs", "wasm"].map(async (directory) => {
          for (const name of await readdir(join(root, directory))) {
            // No WebAssembly or optional PDF scripting. Retain decoder license notices.
            if (
              directory === "wasm" &&
              !/^(?:openjpeg_nowasm_fallback\.js|jbig2_nowasm_fallback\.js|LICENSE_.*(?:OPENJPEG|JBIG2))$/.test(name)
            )
              continue;
            files.set(`${prefix}${directory}/${name}`, await readFile(join(root, directory, name)));
          }
        }),
      );
      files.set(`${prefix}LICENSE`, await readFile(join(root, "LICENSE")));
      return { define: { __PDFJS_ASSET_BASE__: JSON.stringify(`/${prefix}`) } };
    },
    generateBundle() {
      for (const [fileName, source] of files) this.emitFile({ type: "asset", fileName, source });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url || "/", "http://localhost").pathname.slice(1);
        if (!path.startsWith(prefix)) return next();
        const source = files.get(path);
        if (!source) {
          response.statusCode = 404;
          response.end("Not found");
          return;
        }
        response.setHeader(
          "Content-Type",
          path.endsWith(".js") ? "application/javascript" : "application/octet-stream",
        );
        response.end(source);
      });
    },
  };
}
