import { test, expect, type Browser, type Page, type Route } from "@playwright/test";
import { api } from "../../shared/api.ts";
import type { User } from "../../shared/model.ts";
import { BASE, composer, destinations, fileInput, signedIn, unique } from "./helpers";

const MB = 1024 ** 2;
const binary = (name: string, size: number) => ({
  name,
  mimeType: "application/octet-stream",
  buffer: Buffer.alloc(size, 5),
});

/** An administrator API write from the admin's own session. */
async function adminPatch(page: Page, path: string, data: object) {
  const session = await (await page.request.get(api.session.get.path)).json();
  const response = await page.request.patch(path, { data, headers: { "X-Relay-CSRF": session.csrf } });
  expect(response.ok()).toBe(true);
}

/** A new member with its own small storage limit, so changing it never affects other tests' account. */
async function member(admin: Page, browser: Browser, storage: number) {
  const session = await (await admin.request.get(api.session.get.path)).json();
  const invite = await admin.request.post(api.admin.invite.path, { headers: { "X-Relay-CSRF": session.csrf } });
  expect(invite.ok()).toBe(true);
  const { token } = await invite.json();
  const context = await browser.newContext({ baseURL: BASE });
  const joined = await context.request.post(api.session.join.path, {
    data: {
      token,
      username: unique("limited").toLowerCase(),
      password: "Browser-test-password-only",
      deviceName: "Limited laptop",
    },
  });
  expect(joined.ok()).toBe(true);
  const { user } = (await joined.json()) as { user: User };
  let currentLimits = user.limits;
  const setStorage = async (bytes: number) => {
    const limits = { ...currentLimits, storage: bytes };
    await adminPatch(admin, `/api/admin/members/${user.id}`, { limits, expectedLimits: currentLimits });
    currentLimits = limits;
  };
  await setStorage(storage);
  const page = await context.newPage();
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  return { context, page, setStorage };
}

test("going offline mid-upload waits, then carries on by itself when the connection returns", async ({ page }) => {
  await signedIn(page);
  // Hold the first chunk until the browser is offline, then drop it the way a lost connection does.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let patches = 0;
  await page.route("**/uploads/**", async (route) => {
    if (route.request().method() !== "PATCH" || patches++) return route.continue();
    await held;
    await route.abort("internetdisconnected").catch(() => {});
  });
  const name = unique("offline");
  await fileInput(page).setInputFiles([binary(`${name}.bin`, 3 * MB)]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  const card = composer(page).locator(".transfer");
  await expect(card.getByRole("button", { name: "Pause" })).toBeEnabled();
  await expect.poll(() => patches).toBe(1);

  await page.context().setOffline(true);
  await expect(card).toContainText("Paused · waiting for your connection…");
  await expect(card).not.toContainText("left");
  await expect(page.getByRole("status").filter({ hasText: "You’re offline" })).toContainText(
    "Uploads are paused and continue if you’re back within 5 minutes",
  );
  release();

  await page.context().setOffline(false);
  await expect(page.getByRole("status").filter({ hasText: "You’re back online" })).toBeVisible();
  // No Retry: it resumes on its own.
  await expect(card).toContainText("Saved to Files", { timeout: 20_000 });
  await expect(card.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.getByText("You’re offline")).toHaveCount(0);
  const { items } = await (await page.request.get(`/api/items?q=${name}`)).json();
  expect(items[0]).toMatchObject({ files: 1, bytes: 3 * MB, uploading: false });
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a page that couldn't load while offline loads by itself when the connection returns", async ({ page }) => {
  await signedIn(page);
  await page.context().setOffline(true);
  await page.getByRole("link", { name: "Files" }).click();
  // The page waits quietly; the bar under the header is the one place that explains and retries.
  await expect(page.getByText("Waiting for your connection")).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: /Retry|Try/ })).toHaveCount(0);
  await page.context().setOffline(false);
  await expect(page.getByText("Waiting for your connection")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
});

test("after a reload the paused upload is offered back and the same file finishes it", async ({ page }) => {
  await signedIn(page);
  // The first chunk arrives; the rest hang until the page reloads.
  let patches = 0;
  let phase: "hold" | "cut" | "pass" = "hold";
  const held: Route[] = [];
  await page.route("**/uploads/**", (route) => {
    if (route.request().method() !== "PATCH" || patches++ === 0 || phase === "pass") return route.continue();
    if (phase === "cut") return route.abort();
    held.push(route);
  });
  const name = unique("reloaded");
  const bytes = Buffer.from(Array.from({ length: 3 * MB }, (_, i) => (i * 7) % 256));
  const file = { name: `${name}.bin`, mimeType: "application/octet-stream", buffer: bytes };
  await fileInput(page).setInputFiles([file]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(composer(page).locator(".transfer")).toContainText(/1 MB of 3 MB/, { timeout: 15_000 });
  page.on("dialog", (d) => void d.accept());
  // The reload cuts the held request off before any of it reaches Relay.
  phase = "cut";
  await Promise.all(held.map((route) => route.abort().catch(() => {})));
  await page.reload();
  phase = "pass";

  const notice = composer(page)
    .getByRole("status")
    .filter({ hasText: `${name}.bin is paused` });
  await expect(notice).toContainText("1 MB of 3 MB uploaded.");
  await expect(notice).toContainText("what’s uploaded won’t be sent again");

  // A different file under the same name and size is not stitched on.
  let chooser = page.waitForEvent("filechooser");
  await notice.getByRole("button", { name: "Choose files" }).click();
  await (await chooser).setFiles([{ ...file, buffer: Buffer.alloc(3 * MB, 1) }]);
  await expect(notice).toContainText(`${name}.bin isn’t the same as the one being uploaded`);

  const sent: number[] = [];
  await page.route("**/uploads/**", (route) => {
    const r = route.request();
    if (r.method() === "PATCH") sent.push(Number(r.headers()["upload-offset"]));
    return route.continue();
  });
  chooser = page.waitForEvent("filechooser");
  await notice.getByRole("button", { name: "Choose more" }).click();
  await (await chooser).setFiles([file]);
  await expect(composer(page).locator(".transfer")).toContainText("Saved to Files", { timeout: 15_000 });
  await expect(notice).toHaveCount(0);
  // Only what was missing was sent. The request the reload cut off may have left more than the first
  // chunk on the server, which is kept too.
  expect(Math.min(...sent)).toBeGreaterThanOrEqual(MB);
  expect(Math.min(...sent)).toBeLessThan(3 * MB);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const { items } = await (await page.request.get(`/api/items?q=${name}`)).json();
  expect(items[0]).toMatchObject({ files: 1, bytes: 3 * MB, uploading: false });
});

test("waking after the phone slept restarts a stuck upload, and the screen is kept on while sending", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { wakeRequests: number; wakeReleases: number };
    w.wakeRequests = 0;
    w.wakeReleases = 0;
    Object.defineProperty(navigator, "wakeLock", {
      value: {
        request: () => {
          w.wakeRequests++;
          const sentinel = new EventTarget() as EventTarget & { release: () => Promise<void> };
          sentinel.release = () => Promise.resolve(void w.wakeReleases++);
          return Promise.resolve(sentinel);
        },
      },
    });
  });
  await signedIn(page);
  // The connection died while the phone slept: the request in flight never answers.
  let stuck = true;
  await page.route("**/uploads/**", async (route) => {
    if (route.request().method() === "PATCH" && stuck) return new Promise(() => {});
    return route.continue();
  });
  const name = unique("slept");
  await fileInput(page).setInputFiles([binary(`${name}.bin`, 2 * MB)]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(composer(page).locator(".transfer").getByRole("button", { name: "Pause" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { wakeRequests: number }).wakeRequests)).toBe(1);

  stuck = false;
  await page.evaluate(() => {
    const hidden = (value: boolean) => {
      Object.defineProperty(document, "hidden", { value, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    hidden(true);
    // A minute passes asleep.
    const now = Date.now.bind(Date);
    Date.now = () => now() + 60_000;
    hidden(false);
  });
  await expect(composer(page).locator(".transfer")).toContainText("Saved to Files", { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { wakeReleases: number }).wakeReleases)).toBe(1);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a paused upload can be stopped from the notice", async ({ page }) => {
  await signedIn(page);
  await page.route("**/uploads/**", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await new Promise(() => {});
  });
  const name = unique("stopped");
  await fileInput(page).setInputFiles([binary(`${name}.bin`, 2 * MB)]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(composer(page).locator(".transfer").getByRole("button", { name: "Cancel" })).toBeVisible();
  page.on("dialog", (d) => void d.accept());
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload();
  const notice = composer(page)
    .getByRole("status")
    .filter({ hasText: `${name}.bin is paused` });
  await expect(notice).toBeVisible();
  // Nothing finished, so nothing is claimed to be in Files.
  await expect(notice.getByRole("button", { name: "View in Files" })).toHaveCount(0);
  await notice.getByRole("button", { name: "Stop upload" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Stop upload" }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await expect(composer(page).getByText(`${name}.bin is paused`)).toHaveCount(0);
});

test("destinations are off when the selection doesn't fit the storage limit", async ({ page, browser }) => {
  await signedIn(page);
  const { context, page: memberPage } = await member(page, browser, 10 * MB);
  try {
    await fileInput(memberPage).setInputFiles([binary(`${unique("big")}.bin`, 40 * MB)]);
    const panel = destinations(memberPage);
    await expect(panel).toContainText("Not enough space: 10 MB left, this needs 40 MB.");
    await expect(panel.getByRole("button", { name: "Save to Files" })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Create link" })).toBeDisabled();
    await panel.getByRole("button", { name: "Free up space" }).click();
    await expect(memberPage).toHaveURL(/\/files$/);
  } finally {
    await context.close();
  }
});

test("a transfer the server refuses for space says so, with no Retry", async ({ page, browser }) => {
  await signedIn(page);
  const { context, page: memberPage, setStorage } = await member(page, browser, 10 * MB);
  try {
    // The limit shrinks between the check here and the server's.
    await memberPage.route("**/api/transfers", async (route) => {
      if (route.request().method() === "POST") await setStorage(1 * MB);
      await route.continue();
    });
    await fileInput(memberPage).setInputFiles([binary(`${unique("refused")}.bin`, 5 * MB)]);
    await destinations(memberPage).getByRole("button", { name: "Save to Files" }).click();
    const card = composer(memberPage).locator(".transfer");
    await expect(card).toContainText("Not enough space");
    await expect(card).toContainText("You have 1 MB free; this needs 5 MB.");
    await expect(card.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(composer(memberPage)).not.toContainText("Keep this tab open");
    await card.getByRole("button", { name: "Free up space" }).click();
    await expect(memberPage).toHaveURL(/\/files$/);
  } finally {
    await context.close();
  }
});

test("cancelling asks first once real progress would be lost", async ({ page }) => {
  await signedIn(page);
  // Two 8 MB chunks arrive, then the upload holds so it is mid-way when Cancel is pressed.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let patches = 0;
  await page.route("**/uploads/**", async (route) => {
    if (route.request().method() !== "PATCH" || ++patches <= 2) return route.continue();
    await held;
    await route.abort().catch(() => {});
  });
  const name = unique("confirm-cancel");
  await fileInput(page).setInputFiles([binary(`${name}.bin`, 40 * MB)]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  const card = composer(page).locator(".transfer");
  await expect.poll(() => patches).toBeGreaterThan(2);

  await card.getByRole("button", { name: "Cancel" }).click();
  const confirm = page.getByRole("dialog", { name: `Stop uploading ${name}.bin?` });
  await expect(confirm).toContainText(/MB uploaded so far will be discarded\./);
  // Backing out keeps it going.
  await confirm.getByRole("button", { name: "Keep uploading" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Pause" })).toBeVisible();

  await card.getByRole("button", { name: "Cancel" }).click();
  await confirm.getByRole("button", { name: "Stop upload" }).click();
  await expect(card).toContainText("Cancelled");
  release();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
