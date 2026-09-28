import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.RELAY_RESOURCE_PORT || 3197);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: ".",
  timeout: 180_000,
  expect: { timeout: 12_000 },
  workers: 1,
  reporter: "list",
  outputDir: "../../test-results/resources",
  use: { baseURL, trace: "retain-on-failure" },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: "../..",
    url: `${baseURL}/tests/resources/index.html`,
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], deviceScaleFactor: 2 } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], deviceScaleFactor: 2 } },
    { name: "webkit", use: { ...devices["Desktop Safari"], deviceScaleFactor: 2 } },
  ],
});
