import { test, expect } from "@playwright/test";
import { composer, destinations, fileInput, selected, signedIn, textFile, unique } from "./helpers";

for (const section of ["Settings", "Admin"] as const) {
  test(`${section} chunk failure preserves navigation and recovers once the network is back`, async ({ page }) => {
    await signedIn(page);
    const chunk = new RegExp(`/assets/${section}Page-[^/]+\\.js(?:\\?.*)?$`);
    await page.route(chunk, (route) => route.abort());
    await page.getByRole("button", { name: /^Account/ }).click();
    await page.getByRole("menuitem", { name: section }).click();
    const error = page.getByRole("heading", { name: "This page couldn’t load" });
    await expect(error).toBeVisible();
    await expect(error).toBeFocused();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload page", exact: true })).toBeEnabled();
    await page.getByRole("link", { name: "Files", exact: true }).click();
    await expect(error).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
    // Still failing on the next visit, and Try again asks once more.
    await page.getByRole("button", { name: /^Account/ }).click();
    await page.getByRole("menuitem", { name: section }).click();
    await expect(error).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(error).toBeVisible();
    // Once the network is back, Try again loads the page without reloading the tab.
    await page.unroute(chunk);
    await page.evaluate(() => ((window as unknown as { kept: boolean }).kept = true));
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
    await expect(error).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
  });
}

test("page-load recovery keeps an unfinished upload alive and never offers to reload it away", async ({ page }) => {
  await signedIn(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const uploading = new Promise<void>((resolve) => (started = resolve));
  await page.route("**/uploads/**", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    started();
    await held;
    await route.continue().catch(() => {});
  });
  try {
    await fileInput(page).setInputFiles([textFile(`${unique("page-failure")}.txt`, "bytes must still arrive")]);
    await destinations(page).getByRole("button", { name: "Save to Files", exact: true }).click();
    await uploading;
    await page.route(/\/assets\/SettingsPage-[^/]+\.js(?:\?.*)?$/, (route) => route.abort());
    await page.getByRole("button", { name: /^Account/ }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "This page couldn’t load" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload page", exact: true })).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: "Uploads are still open" })).toBeVisible();
    await page.getByRole("button", { name: "Go to Send" }).click();
    const transfer = page.locator(".transfer").first();
    await expect(transfer.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    release();
    await expect(transfer).toContainText("Saved to Files");
    await page.getByRole("button", { name: /^Account/ }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page.getByRole("button", { name: "Reload page", exact: true })).toBeEnabled();
  } finally {
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("reload recovery asks before discarding selected files and cancellation preserves the draft", async ({ page }) => {
  await signedIn(page);
  const name = `${unique("keep-draft")}.txt`;
  await fileInput(page).setInputFiles([textFile(name)]);
  await page.route(/\/assets\/SettingsPage-[^/]+\.js(?:\?.*)?$/, (route) => route.abort());
  await page.getByRole("button", { name: /^Account/ }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Reload page", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Reload and clear selected files?");
  await page.getByRole("button", { name: "Keep selection" }).click();
  await page.getByRole("button", { name: "Go to Send" }).click();
  await expect(composer(page)).toBeVisible();
  await expect(selected(page)).toContainText(name);
});
