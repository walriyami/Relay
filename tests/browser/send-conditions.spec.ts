import { test, expect, type Browser, type Page } from "@playwright/test";
import { api } from "../../shared/api.ts";
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

/** A new member with its own small quota, so changing it never affects other tests' account. */
async function member(admin: Page, browser: Browser, quota: number) {
  const session = await (await admin.request.get(api.session.get.path)).json();
  const invite = await admin.request.post(api.admin.invite.path, { headers: { "X-Relay-CSRF": session.csrf } });
  expect(invite.ok()).toBe(true);
  const { token } = await invite.json();
  const context = await browser.newContext({ baseURL: BASE });
  const joined = await context.request.post(api.session.join.path, {
    data: {
      token,
      username: unique("quota").toLowerCase(),
      password: "Browser-test-password-only",
      deviceName: "Quota laptop",
    },
  });
  expect(joined.ok()).toBe(true);
  const { user } = await joined.json();
  const setQuota = (bytes: number) => adminPatch(admin, `/api/admin/members/${user.id}`, { quota: bytes });
  await setQuota(quota);
  const page = await context.newPage();
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  return { context, page, setQuota };
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

  await page.context().setOffline(true);
  await expect(card).toContainText("Paused · waiting for your connection…");
  await expect(card).not.toContainText("left");
  await expect(page.getByRole("status").filter({ hasText: "You’re offline" })).toContainText(
    "Uploads are paused and continue if you’re back within 5 minutes",
  );
  release();

  await page.context().setOffline(false);
  // No Retry: it resumes on its own.
  await expect(card).toContainText("Saved to Files", { timeout: 20_000 });
  await expect(card.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.getByText("You’re offline")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "You’re back online" })).toBeVisible();
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

test("after a reload the drop box says what stopped and offers to choose it again", async ({ page }) => {
  await signedIn(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/uploads/**", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await held;
    await route.abort().catch(() => {});
  });
  const name = unique("reloaded");
  await fileInput(page).setInputFiles([binary(`${name}.bin`, 2 * MB)]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(composer(page).locator(".transfer").getByRole("button", { name: "Cancel" })).toBeVisible();
  page.on("dialog", (d) => void d.accept());
  await page.reload();

  const notice = composer(page).getByRole("status").filter({ hasText: "stopped" });
  await expect(notice).toContainText(`Your upload of ${name}.bin stopped when the page reloaded.`);
  await expect(notice).toContainText("Choose it again to send it.");
  // Nothing finished, so nothing is claimed to be in Files.
  await expect(notice).not.toContainText("in Files");
  const chooser = page.waitForEvent("filechooser");
  await notice.getByRole("button", { name: "Choose again" }).click();
  await chooser;
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
  release();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // Said once: the next load starts clean.
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await expect(composer(page).getByText(/stopped when/)).toHaveCount(0);
});

test("destinations are off when the selection doesn't fit the quota", async ({ page, browser }) => {
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
  const { context, page: memberPage, setQuota } = await member(page, browser, 10 * MB);
  try {
    // The quota shrinks between the check here and the server's.
    await memberPage.route("**/api/transfers", async (route) => {
      if (route.request().method() === "POST") await setQuota(1 * MB);
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
