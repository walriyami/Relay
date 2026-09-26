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
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/browser-server.ts",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 45000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
