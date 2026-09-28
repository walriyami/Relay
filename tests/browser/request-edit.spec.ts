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
  await page.clock.install();
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

  const notice = page.locator(".toast", { hasText: `New files for ${name}` });
  await expect(notice).toBeVisible();
  // Keep the incoming notification present throughout validation, including when it overlaps Save.
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const full = row(page, name);
  await expect(full.locator(".pill")).toHaveText("Full");
  await expect(full).toContainText("No room for more · review saved, retained and reserved space");
  await full.getByRole("button", { name: "Raise limit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit request" });
  const size = dialog.getByLabel("Total size limit (GB)");
  await expect(size).toBeFocused();
  await expect(dialog).toContainText(
    "12 B active · 0 B in Trash or expired · 0 B reserved. Accepted uploads can finish if limits are reduced.",
  );
  const save = dialog.getByRole("button", { name: "Save" });
  // The final form action wraps back to the dialog header, even with a notification present.
  await save.focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await size.fill("0");
  await save.click();
  await page.clock.runFor(1);
  await expect(dialog.getByRole("alert")).toHaveText("Enter a size limit above 0 and up to 1,024 GB.");
  await expect(size).toBeFocused();
  await expect(size).toHaveAttribute("aria-invalid", "true");
  await size.fill("0.00000001");
  await expect(notice).toBeVisible();
  await save.click();
  await page.clock.resume();
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

test("expired and closed requests keep received files but cannot be edited or reopened", async ({ page, browser }) => {
  const visitor = await browser.newContext();
  const guest = await visitor.newPage();
  const sendFile = async (token: string, filename: string) => {
    await guest.goto(`/r/${token}`);
    await guest.getByTestId("guest-file-input").setInputFiles([textFile(filename, "received before closing")]);
    await guest.getByRole("button", { name: "Upload 1 file", exact: true }).click();
    await expect(guest.locator(".guest-sent")).toBeVisible();
  };
  const name = unique("expired-final");
  const expiringRequest = await apiRequest(page, name, 1024 ** 3, 1);
  await sendFile(expiringRequest.token, `${name}.txt`);
  // Two days on in this browser: the request reads as expired.
  await page.clock.install({ time: Date.now() + 2 * 86_400_000 });
  await page.reload();
  const expired = row(page, name, "Closed requests");
  await expect(expired).toContainText("Expired");
  await page.getByRole("button", { name: `More actions for ${name}` }).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["View received files", "Create new request"]);
  await page.getByRole("menu").getByRole("menuitem", { name: "View received files" }).click();
  const received = page.getByRole("dialog", { name });
  await expect(received).toContainText("This request has expired and cannot reopen.");
  await expect(received.locator(".submission-list")).toContainText(`${name}.txt`);
  await expect(received.getByRole("button", { name: /Edit|Reopen/ })).toHaveCount(0);
  await expect(received.getByRole("button", { name: "New request", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // Closing is final: no Edit or Reopen afterwards.
  const closedName = unique("closed-final");
  const closedRequest = await apiRequest(page, closedName);
  await sendFile(closedRequest.token, `${closedName}.txt`);
  await visitor.close();
  await menuItem(page, closedName, "Close request");
  await page.getByRole("dialog").getByRole("button", { name: "Close request" }).click();
  await expect(row(page, closedName, "Closed requests")).toContainText("Closed");
  await page.getByRole("button", { name: `More actions for ${closedName}` }).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["View received files", "Create new request"]);
  await page.keyboard.press("Escape");
  await row(page, closedName, "Closed requests").locator(".list-text").click();
  const closedReceived = page.getByRole("dialog", { name: closedName });
  await expect(closedReceived.locator(".submission-list")).toContainText(`${closedName}.txt`);
  await expect(closedReceived.getByRole("button", { name: /Edit|Reopen/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The replacement action creates a different request; it cannot revive the original link or code.
  await menuItem(page, closedName, "Create new request");
  const create = page.getByRole("dialog", { name: "New request", exact: true });
  const replacementName = unique("replacement");
  await expect(create.getByLabel("What are you asking for?")).toHaveValue("");
  await create.getByLabel("What are you asking for?").fill(replacementName);
  const created = page.waitForResponse(
    (response) => response.url().endsWith("/api/requests") && response.request().method() === "POST",
  );
  await create.getByRole("button", { name: "Create request", exact: true }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const replacement = await response.json();
  expect(replacement.id).not.toBe(closedRequest.id);
  expect(replacement.token).not.toBe(closedRequest.token);
  expect(replacement.code).not.toBe(closedRequest.code);
  await expect(page.getByRole("dialog", { name: replacementName })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(row(page, closedName, "Closed requests")).toContainText("Closed");
  await expect(row(page, replacementName)).toBeVisible();
  const original = await page.request.get(`/api/r/${closedRequest.token}`);
  expect(original.status()).toBe(410);
});

for (const earlierErrors of [0, 3]) {
  test(`mobile dialog errors stay visible through nested dialogs without covering their controls (${earlierErrors} earlier errors)`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.clock.install();
    const name = unique("copy-failure");
    await apiRequest(page, name);
    await row(page, name).getByRole("button", { name: "Share", exact: true }).click();
    const share = page.getByRole("dialog", { name, exact: true });
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("Clipboard denied")) },
      });
      document.execCommand = () => false;
    });
    for (let i = 0; i < earlierErrors; i++) {
      await share.getByRole("button", { name: "Copy code", exact: true }).click();
      await expect(page.locator(".toast-error")).toHaveCount(i + 1);
    }
    const copy = share.getByRole("button", { name: "Copy link", exact: true });
    // Start with keyboard focus explicitly: Safari pointer clicks do not focus buttons.
    await copy.focus();
    await copy.press("Enter");
    const notice = page.locator(".toast-error").filter({ hasText: "Couldn’t copy this link." });
    await expect(notice).toHaveText("Couldn’t copy this link. Scan the QR code with another device.");
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const readable = () =>
      notice.locator("strong").evaluate((text) => {
        const rect = text.getBoundingClientRect();
        const region = text.closest(".toaster")!.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return (
          rect.top >= Math.max(0, region.top) &&
          rect.bottom <= Math.min(innerHeight, region.bottom) &&
          text.contains(hit)
        );
      });
    // Visibility alone passes for a toast hidden underneath the mobile sheet.
    await expect.poll(readable).toBe(true);
    await expect(share.locator(".toast-error")).toHaveCount(earlierErrors + 1);
    await expect(copy).toBeFocused();
    await expect(page.locator(".toast-error")).toHaveCount(earlierErrors + 1);
    await expect(notice).toHaveAttribute("role", "alert");
    await expect(share.locator(".toaster")).toHaveAttribute("aria-live", "polite");
    await page.screenshot({ path: testInfo.outputPath("mobile-copy-error.png"), animations: "disabled" });
    await share.getByRole("button", { name: "Edit request" }).click();
    const edit = page.getByRole("dialog", { name: "Edit request", exact: true });
    await expect(edit).toBeVisible();
    await expect(notice).toHaveCount(1);
    await expect(edit.locator(".toast-error")).toHaveCount(earlierErrors + 1);
    await expect(share.locator(".toast-error")).toHaveCount(0);
    await expect.poll(readable).toBe(true);
    // Notification controls participate in this dialog's trap, including Safari's button order.
    const dismiss = notice.getByRole("button", { name: "Dismiss", exact: true });
    await dismiss.focus();
    await page.keyboard.press("Shift+Tab");
    if (earlierErrors) {
      await expect(
        edit
          .locator(".toast-error")
          .nth(earlierErrors - 1)
          .getByRole("button", { name: "Dismiss" }),
      ).toBeFocused();
    } else {
      await expect(edit.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    }
    await page.keyboard.press("Tab");
    await expect(dismiss).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(edit.getByLabel("What are you asking for?")).toBeFocused();
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.clock.runFor(200);
    await expect(edit).toHaveCount(0);
    await expect(share.locator(".toast-error")).toHaveCount(earlierErrors + 1);
    await expect.poll(readable).toBe(true);
    await share.getByRole("button", { name: "Close", exact: true }).click();
    await page.clock.runFor(200);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(notice).toHaveCount(1);
    await expect.poll(readable).toBe(true);
    await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(notice).toHaveCount(0);
  });
}

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
