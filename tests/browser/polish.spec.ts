import { test, expect } from "@playwright/test";
import type { ItemSummary, Link } from "../../shared/model";
import { deviceState, signedIn } from "./helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const item = (now: number, name: string): ItemSummary => ({
  id: `00000000-0000-4000-8000-${name.length.toString().padStart(12, "0")}`,
  name,
  autoName: false,
  created: now - DAY,
  firstSavedAt: now - DAY,
  maxAgeDays: null,
  hardExpires: null,
  expires: null,
  trashed: null,
  purgeAt: null,
  requestId: null,
  files: 1,
  texts: 0,
  folders: 0,
  bytes: 10,
  topFiles: 1,
  topFolders: 0,
  preview: null,
  mosaic: [],
  textExcerpt: null,
  linked: true,
  uploading: false,
});

const link = (now: number, id: string, patch: Partial<Link>): Link => {
  const it = item(now, `Polish ${id}`);
  return {
    id,
    itemId: it.id,
    item: it,
    token: `token-${id}`,
    code: "123456",
    created: now - DAY,
    expires: now + 7 * DAY,
    revoked: false,
    available: true,
    full: false,
    locked: false,
    visitorLimit: null,
    note: "",
    visitors: 0,
    downloads: 0,
    lastVisit: null,
    ...patch,
  };
};

test("links show their state as chips, with the password lock in front of the name", async ({ page }) => {
  const now = Date.now();
  const soon = link(now, "soon", { expires: now + 5 * HOUR, locked: true, visitors: 2, lastVisit: now });
  const fresh = link(now, "fresh", {});
  const off = link(now, "off", { revoked: true, available: false, visitors: 1 });
  await page.route("**/api/links", (route) => route.fulfill({ json: [soon, fresh, off] }));
  await signedIn(page);
  await page.getByRole("link", { name: "Links", exact: true }).click();

  const row = page.locator(".link-row-item", { hasText: "Polish soon" });
  // The lock comes before the name, so a name cut off on a narrow screen never hides it.
  const title = row.locator(".status-row-title");
  await expect(title.locator(":scope > :first-child")).toHaveAttribute("aria-label", "Has a password");
  await expect(row.locator(".chip-warn")).toHaveText("Expires in 5 h");
  await expect(row.locator(".chip-good")).toHaveText(/^Opened by 2 browsers · /);

  const quiet = page.locator(".link-row-item", { hasText: "Polish fresh" });
  await expect(quiet.locator(".chip-warn, .chip-good")).toHaveCount(0);
  await expect(quiet.locator(".chip")).toHaveText(["Expires in 7 days", "Not opened yet"]);

  await page.getByRole("button", { name: "Show 1", exact: true }).click();
  const ended = page.locator(".link-row-item", { hasText: "Polish off" });
  await expect(ended.locator(".chip-off")).toHaveText("Turned off");
});

test("a slow start shows the app's frame and the page's placeholders, not a blank screen", async ({ page }) => {
  await signedIn(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/session", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/links");
  const shell = page.locator(".boot-shell");
  await expect(shell.locator(".topbar")).toHaveCSS("opacity", "1");
  await expect(shell.locator(".nav-link.active")).toHaveText("Links");
  await expect(shell.getByRole("heading", { name: "Links" })).toBeVisible();
  await expect(shell.locator(".list-skeleton")).toBeVisible();
  release();
  await expect(page.locator(".boot-shell")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Links", exact: true }).first()).toHaveAttribute("aria-current", "page");
});

test("a browser that wasn't signed in waits on a quiet card, without the app's navigation", async ({ browser }) => {
  // Signed-in cookies but no remembered hint: the frame must not guess at the app.
  const context = await browser.newContext({ storageState: { cookies: (await deviceState("Laptop")).cookies, origins: [] } });
  const page = await context.newPage();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/session", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/files");
  await expect(page.locator(".boot-public .boot-card")).toHaveCSS("opacity", "1");
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  release();
  await expect(page.getByRole("heading", { name: "Files", level: 1 })).toBeVisible();
  await context.close();
});
