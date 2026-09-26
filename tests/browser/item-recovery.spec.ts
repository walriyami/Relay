import { test, expect, type Page } from "@playwright/test";
import { destinations, fileInput, signedIn, textFile, unique } from "./helpers";

async function openSavedItem(page: Page) {
  await signedIn(page);
  const name = `${unique("live-item")}.txt`;
  await fileInput(page).setInputFiles([textFile(name, "A useful cached preview")]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await page
    .getByRole("list", { name: "Recent" })
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Share", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/files\/[0-9a-f-]{36}$/);
  const session = await (await page.request.get("/api/session")).json();
  return { id: new URL(page.url()).pathname.split("/").pop()!, headers: { "X-Relay-CSRF": session.csrf } };
}

test("an open item follows Trash state and removes stale content and actions after permanent deletion", async ({
  page,
}) => {
  const { id, headers } = await openSavedItem(page);
  const dialog = page.getByRole("dialog");
  expect((await page.request.post(`/api/items/${id}/trash`, { headers })).ok()).toBeTruthy();
  await expect(dialog.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  expect((await page.request.delete(`/api/items/${id}`, { headers })).ok()).toBeTruthy();
  await expect(dialog.getByRole("heading", { name: "Unavailable", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Restore|Delete forever|Share|Download/ })).toHaveCount(0);
  await expect(dialog.getByText("A useful cached preview", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("status")).not.toBeEmpty();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("a temporary item refresh failure preserves the preview and offers recovery", async ({ page }) => {
  const { id, headers } = await openSavedItem(page);
  let fail = true;
  await page.route(`**/api/items/${id}`, (route) =>
    fail ? route.fulfill({ status: 503, json: { error: "Temporary item outage" } }) : route.continue(),
  );
  // A real item event triggers the existing live refresh, as another tab's action would.
  expect((await page.request.post(`/api/items/${id}/trash`, { headers })).ok()).toBeTruthy();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Temporary item outage");
  await expect(dialog.getByText("A useful cached preview", { exact: true })).toBeVisible();
  fail = false;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
});
