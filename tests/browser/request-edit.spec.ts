import { test, expect, type Page } from "@playwright/test";
import { copyShareUrl, signedIn, textFile, unique } from "./helpers";

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

/** Creates a request through the API (for sizes the form doesn't offer) and opens Requests. */
async function apiRequest(page: Page, name: string, maxBytes = 1024 ** 3, days = 7) {
  const session = await (await page.request.get("/api/session")).json();
  const response = await page.request.post("/api/requests", {
    headers: { "X-Relay-CSRF": session.csrf },
    data: { id: crypto.randomUUID(), name, days, maxBytes },
  });
  expect(response.ok()).toBe(true);
  await page.getByRole("link", { name: "Requests" }).click();
  return (await response.json()) as { id: string; token: string; code: string };
}
const row = (page: Page, name: string, list = "Open requests") =>
  page.getByRole("list", { name: list }).getByRole("listitem").filter({ hasText: name });
const menuItem = async (page: Page, name: string, item: string) => {
  await page.getByRole("button", { name: `More actions for ${name}` }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item }).click();
};

test("editing a request keeps its link and code, and the guest page follows", async ({ page, browser }) => {
  const name = unique("edit");
  const request = await apiRequest(page, name);
  const visitor = await browser.newContext();
  const guest = await visitor.newPage();
  await guest.goto(`/r/${request.token}`);
  await expect(guest.getByRole("heading", { name })).toBeVisible();
  await expect(guest.getByText("Up to 1 GB · Closes in 7 days")).toBeVisible();

  await menuItem(page, name, "Edit request");
  const dialog = page.getByRole("dialog", { name: "Edit request" });
  await expect(dialog).toContainText("The link and code stay the same.");
  const field = dialog.getByLabel("What are you asking for?");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(name);
  // Nothing is chosen for how long it stays open until you choose: its date is shown instead.
  await expect(dialog.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(dialog).toContainText(/Closes \w+ \d+ \(in 7 days\)\./);
  await field.fill(`${name} v2`);
  await dialog.getByLabel("Message (optional)").fill("Scans are fine.");
  await dialog.getByRole("radio", { name: "30 days" }).click();
  await expect(dialog).toContainText(/Closes \w+ \d+, counted from now\./);
  await dialog.getByRole("button", { name: "Change", exact: true }).click();
  await expect(dialog.getByLabel("Total size limit (GB)")).toHaveValue("1");
  await dialog.getByLabel("Total size limit (GB)").fill("2.5");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Request updated")).toBeVisible();
  await expect(page.getByRole("button", { name: `More actions for ${name} v2` })).toBeFocused();
  await expect(row(page, `${name} v2`)).toContainText("Closes in 30 days");

  // Same link and code in the share handoff.
  await row(page, `${name} v2`).getByRole("button", { name: "Share" }).click();
  const share = page.getByRole("dialog", { name: `${name} v2` });
  await expect(share).toContainText("Up to 2.5 GB · Closes in 30 days");
  await expect(share.getByText(request.code)).toBeVisible();
  expect(await copyShareUrl(share)).toContain(`/r/${request.token}`);

  // The guest page catches up when it comes back into view.
  await guest.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(guest.getByRole("heading", { name: `${name} v2` })).toBeVisible();
  await expect(guest.getByText("Scans are fine.")).toBeVisible();
  await expect(guest.getByText("Up to 2.5 GB · Closes in 30 days")).toBeVisible();
  await visitor.close();
});

test("saving an unchanged request sends nothing; Edit is offered from sharing and received files", async ({ page }) => {
  const name = unique("edit-entry");
  await apiRequest(page, name);
  let patches = 0;
  page.on("request", (r) => r.method() === "PATCH" && r.url().includes("/api/requests/") && patches++);

  await row(page, name).getByRole("button", { name: "Share" }).click();
  await page.getByRole("dialog", { name }).getByRole("button", { name: "Edit request" }).click();
  const edit = page.getByRole("dialog", { name: "Edit request" });
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  // Back on the share dialog it was opened from.
  await expect(page.getByRole("dialog", { name })).toBeVisible();
  expect(patches).toBe(0);
  await page.keyboard.press("Escape");

  await row(page, name).locator(".list-text").click();
  const received = page.getByRole("dialog", { name });
  await received.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("dialog", { name: "Edit request" })).toBeVisible();
  await page.getByRole("dialog", { name: "Edit request" }).getByLabel("What are you asking for?").fill(`${name}!`);
  await page.getByRole("dialog", { name: "Edit request" }).getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog", { name: `${name}!` })).toBeVisible();
  expect(patches).toBe(1);
});

test("a full request's limit can be raised, and never set below what it holds", async ({ page, browser }) => {
  const name = unique("raise");
  const request = await apiRequest(page, name, 12);
  const visitor = await browser.newContext();
  const guest = await visitor.newPage();
  await guest.goto(`/r/${request.token}`);
  await guest.getByTestId("guest-file-input").setInputFiles([textFile(`${name}-a.txt`, "twelve bytes")]);
  await guest.getByRole("button", { name: "Upload 1 file", exact: true }).click();
  await expect(guest.locator(".guest-sent")).toContainText(
    "This request is full. admin has received the 12 B it allows.",
  );

  const full = row(page, name);
  await expect(full.locator(".pill")).toHaveText("Full");
  await expect(full).toContainText("raise its limit or close it");
  await full.getByRole("button", { name: "Raise limit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit request" });
  const size = dialog.getByLabel("Total size limit (GB)");
  await expect(size).toBeFocused();
  await expect(dialog).toContainText("Already holds 12 B.");
  await size.fill("0");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Enter a size limit above 0 and up to 1,024 GB.");
  await expect(size).toBeFocused();
  await expect(size).toHaveAttribute("aria-invalid", "true");
  await size.fill("0.00000001");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("This request already holds 12 B. Choose at least that.");
  await size.fill("1");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(full.locator(".pill")).toHaveCount(0);
  await expect(full.getByRole("button", { name: "Share" })).toBeVisible();

  // The guest can send again after a reload.
  await guest.reload();
  await expect(guest.getByText("Up to 1 GB")).toBeVisible();
  await expect(guest.getByRole("button", { name: "Add files" })).toBeVisible();
  await visitor.close();
});

test("an expired request reopens with the same link; a closed one can't be edited", async ({ page, browser }) => {
  const name = unique("reopen");
  const request = await apiRequest(page, name, 1024 ** 3, 1);
  // Two days on in this browser: the request reads as expired.
  await page.clock.install({ time: Date.now() + 2 * 86_400_000 });
  await page.reload();
  const expired = row(page, name, "Closed requests");
  await expect(expired).toContainText("Expired");
  await menuItem(page, name, "Reopen request");
  const dialog = page.getByRole("dialog", { name: "Reopen request" });
  await expect(dialog).toContainText("The same link and code work again.");
  await expect(dialog.getByRole("radio", { name: "7 days" })).toBeChecked();
  await expect(dialog).toContainText(/Open until \w+ \d+, counted from now\./);
  await dialog.getByRole("button", { name: "Reopen request" }).click();
  await expect(page.getByText("Request reopened")).toBeVisible();
  await expect(row(page, name)).toBeVisible();

  const visitor = await browser.newContext();
  const guest = await visitor.newPage();
  await guest.goto(`/r/${request.token}`);
  await expect(guest.getByRole("heading", { name })).toBeVisible();
  await visitor.close();

  // Closing is final: no Edit or Reopen afterwards.
  await menuItem(page, name, "Close request");
  await page.getByRole("dialog").getByRole("button", { name: "Close request" }).click();
  await expect(row(page, name, "Closed requests")).toContainText("Closed");
  await page.getByRole("button", { name: `More actions for ${name}` }).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["View received files"]);
  await page.keyboard.press("Escape");
  await row(page, name, "Closed requests").locator(".list-text").click();
  await expect(page.getByRole("dialog", { name }).getByRole("button", { name: /Edit|Reopen/ })).toHaveCount(0);
});

test("an edit ends when the request is closed in another tab", async ({ page }) => {
  const name = unique("edit-stale");
  await apiRequest(page, name);
  await menuItem(page, name, "Edit request");
  const dialog = page.getByRole("dialog", { name: "Edit request" });
  await dialog.getByLabel("What are you asking for?").fill("Unsaved");

  const other = await page.context().newPage();
  await other.goto("/requests");
  await menuItem(other, name, "Close request");
  await other.getByRole("dialog").getByRole("button", { name: "Close request" }).click();
  await expect(other.getByText("Request closed")).toBeVisible();
  await other.close();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("This request was closed.")).toBeVisible();
  await expect(row(page, name, "Closed requests")).toBeVisible();
});
