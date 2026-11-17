import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.RELAY_TEST_PORT || 3091);
const baseURL = `http://localhost:${port}`;
export default defineConfig({
  testDir: "tests/browser",
  timeout: 60000,
  expect: { timeout: 12000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    // Recording a trace screenshots every step of every test, even ones that pass. Only CI keeps them;
    // locally, rerun a failing test with --trace on.
    trace: process.env.CI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/browser-server.ts",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 45000,
  },
  // `npm run test:e2e` runs only chromium; `npm run test:e2e:all` (CI and releases) runs all four.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
