import { expect, request, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { api } from "../../shared/api.ts";
import { destinations, fileInput, unique } from "./helpers.ts";

// Direct transfers need a Relay with a helper, which the shared browser-test server has not: with
// one, every other spec's uploads would go around the failures they simulate. This spec runs its own.
const PORT = Number(process.env.RELAY_TEST_PORT || 3091) + 10;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = "Browser-test-password-only";
let server: ChildProcess;

test.use({ baseURL: BASE });
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  server = spawn(process.execPath, ["tests/browser-server.ts"], {
    env: {
      ...process.env,
      RELAY_TEST_PORT: String(PORT),
      RELAY_TEST_LOCAL: String(20000 + Math.floor(Math.random() * 12000)),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let started = Date.now(); ;) {
    if (
      await fetch(`${BASE}/api/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (Date.now() - started > 30_000) throw new Error("The direct-transfer test server didn't start.");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});
test.afterAll(async () => {
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  await exited;
});

async function signIn(page: Page) {
  const context = await request.newContext({ baseURL: BASE });
  const response = await context.post(api.session.password.path, {
    data: { username: "admin", password: PASSWORD, deviceName: "Home laptop" },
  });
  expect(response.ok()).toBe(true);
  await page.context().addCookies((await context.storageState()).cookies);
  await context.dispose();
  await page.goto("/");
}

/** Bulk requests that went over HTTP rather than the direct connection. */
function overHttp(page: Page) {
  const seen: string[] = [];
  page.on("request", (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.startsWith("/uploads/") || /^\/api\/(nodes|items)\/[^/]+\/(content|zip)$/.test(pathname))
      seen.push(`${req.method()} ${pathname.replace(/[0-9a-f-]{36}/g, ":id")}`);
  });
  return seen;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function save(page: Page, name: string, data: Buffer) {
  await fileInput(page).setInputFiles([{ name, mimeType: "application/octet-stream", buffer: data }]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files", { timeout: 60_000 });
}

async function download(page: Page, name: string) {
  const card = page.getByRole("list", { name: "Recent" }).locator(".collection-card", { hasText: name }).first();
  await card.getByRole("button", { name: /Actions for/ }).click();
  const started = page.waitForEvent("download");
  await page.getByRole("menu").getByRole("menuitem", { name: "Download", exact: true }).click();
  const file = await started;
  return { path: new URL(file.url()).pathname, data: await readFile(await file.path()) };
}

/**
 * Whether the browser can connect to itself over WebRTC. Playwright's Firefox can't (it gathers no
 * candidates), so there direct transfers never start and everything goes the usual way.
 */
async function canConnect(page: Page) {
  return page.evaluate(async () => {
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    a.onicecandidate = ({ candidate }) => void (candidate && b.addIceCandidate(candidate));
    b.onicecandidate = ({ candidate }) => void (candidate && a.addIceCandidate(candidate));
    const channel = a.createDataChannel("probe");
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription!);
    const open = await Promise.race([
      new Promise<boolean>((resolve) => (channel.onopen = () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    a.close();
    b.close();
    return open;
  });
}

test("on Relay's network, uploads and downloads go direct, and can be switched off", async ({ page }) => {
  await page.goto("/");
  test.skip(!(await canConnect(page)), "This browser can't make WebRTC connections here.");
  const http = overHttp(page);
  await signIn(page);
  const on = page.getByRole("button", { name: "Direct transfers on" });
  await expect(on).toBeVisible();
  // A connection that loses its path is given up on after a few seconds: well past that, with every
  // lane set up, it's still there.
  await page.waitForTimeout(8000);

  // Several chunks, so the upload takes tus's path, and a download larger than every window.
  const direct = unique("direct");
  const data = randomBytes(24 * 1024 ** 2);
  await save(page, `${direct}.bin`, data);
  expect(http).toEqual([]);
  const fetched = await download(page, direct);
  expect(fetched.path).toMatch(/^\/local\/download\//);
  expect(sha256(fetched.data)).toBe(sha256(data));
  expect(http).toEqual([]);

  await on.click();
  const popover = page.getByRole("dialog", { name: "Direct transfers" });
  await popover.getByRole("switch", { name: "Transfer directly" }).click();
  await expect(page.getByRole("button", { name: "Direct transfers off" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Switched off, everything goes the usual way.
  const usual = unique("usual");
  const small = randomBytes(512 * 1024);
  await save(page, `${usual}.bin`, small);
  expect(http.some((line) => line.startsWith("PATCH /uploads/"))).toBe(true);
  const plain = await download(page, usual);
  expect(plain.path).toMatch(/^\/api\/nodes\/[^/]+\/content$/);
  expect(sha256(plain.data)).toBe(sha256(small));
});
