import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
