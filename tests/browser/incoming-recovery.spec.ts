import { test as base, expect, type Locator, type Page } from "@playwright/test";
import type { TransferResult } from "../../shared/model";
import { destinations, deviceContext, deviceName, fileInput, signedIn, textFile, unique } from "./helpers";

const senderName = unique("Care sender");
const receiverName = unique("Care receiver");
const preview = "A useful received preview";
const deliveryActions = /^(Accept and download|Decline|Open in Files|Download|Retry)$/;

const test = base.extend<{ receiver: Page }>({
  receiver: async ({ browser }, use) => {
    const receiver = await deviceContext(browser, receiverName);
    try {
      // Auto-accept belongs to this fresh browser context, never the shared account's preferences.
      await receiver.page.getByRole("button", { name: /^Account:/ }).click();
      const autoAccept = receiver.page.getByRole("menuitemcheckbox", { name: "Auto-accept" });
      await expect(autoAccept).toHaveAttribute("aria-checked", "true");
      await autoAccept.click();
      await expect(autoAccept).toHaveAttribute("aria-checked", "false");
      await receiver.page.keyboard.press("Escape");
      await use(receiver.page);
    } finally {
      await receiver.context.close();
    }
  },
});

async function sendFile(sender: Page, receiver: Page) {
  await signedIn(sender, senderName);
  const filename = `${unique("incoming-care")}.txt`;
  await fileInput(sender).setInputFiles(textFile(filename, preview));
  const sent = sender.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /^\/api\/transfers\/[^/]+\/complete$/.test(new URL(response.url()).pathname),
  );
  await destinations(sender)
    .getByRole("button", { name: await deviceName(receiverName), exact: true })
    .click();
  const response = await sent;
  expect(response.ok()).toBe(true);
  const { itemId, delivery } = (await response.json()) as TransferResult;
  expect(delivery?.itemId).toBe(itemId);
  await receiver.bringToFront();
  const dialog = receiver.getByRole("dialog", { name: filename, exact: true });
  await expect(dialog).toBeVisible();
  const session = await (await sender.request.get("/api/session")).json();
  return { id: itemId, dialog, filename, headers: { "X-Relay-CSRF": session.csrf } };
}

async function expectPreview(dialog: Locator, filename: string) {
  await expect(dialog.getByRole("region", { name: `Preview of ${filename}` })).toContainText(preview);
  await expect(dialog.getByRole("button", { name: "Accept and download", exact: true })).toBeVisible();
}

async function expectUnavailable(dialog: Locator, filename: string) {
  await expect(dialog.getByRole("status")).toHaveText("This item is no longer available.");
  await expect(dialog.getByRole("region", { name: `Preview of ${filename}` })).toHaveCount(0);
  await expect(dialog.getByText(preview, { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: deliveryActions })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Close", exact: true }).last()).toBeVisible();
}

test("a received item's initial temporary failure offers Retry and loads successfully", async ({ page, receiver }) => {
  let fail = true;
  await receiver.route(/\/api\/items\/[^/?]+$/, (route) =>
    fail && route.request().method() === "GET"
      ? route.fulfill({ status: 503, json: { error: "Temporary received item outage" } })
      : route.continue(),
  );
  const { dialog, filename } = await sendFile(page, receiver);
  await expect(dialog.getByRole("alert")).toContainText("Temporary received item outage");
  await expect(dialog.getByText("This item is no longer available.")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /^(Accept and download|Decline)$/ })).toHaveCount(0);
  fail = false;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expectPreview(dialog, filename);
});

test("a received item's temporary refresh failure keeps its preview and retries", async ({ page, receiver }) => {
  const { id, dialog, filename, headers } = await sendFile(page, receiver);
  await expectPreview(dialog, filename);
  let fail = true;
  await receiver.route(`**/api/items/${id}`, (route) =>
    fail ? route.fulfill({ status: 503, json: { error: "Temporary received item refresh outage" } }) : route.continue(),
  );
  // A real item event refreshes the popup while the delivery itself remains available.
  expect((await page.request.patch(`/api/items/${id}`, { headers, data: { retentionDays: 30 } })).ok()).toBe(true);
  await expect(dialog.getByRole("alert")).toContainText("Temporary received item refresh outage");
  await expectPreview(dialog, filename);
  fail = false;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expectPreview(dialog, filename);
});

test("an authoritative received item denial removes the cached preview and delivery actions", async ({
  page,
  receiver,
}) => {
  const { id, dialog, filename, headers } = await sendFile(page, receiver);
  await expectPreview(dialog, filename);
  await receiver.route(`**/api/items/${id}`, (route) =>
    route.fulfill({ status: 403, json: { error: "This item is unavailable to this browser." } }),
  );
  expect((await page.request.patch(`/api/items/${id}`, { headers, data: { retentionDays: 30 } })).ok()).toBe(true);
  await expectUnavailable(dialog, filename);
});

test("trashing a received item removes the cached preview and delivery actions", async ({ page, receiver }) => {
  const { id, dialog, filename, headers } = await sendFile(page, receiver);
  await expectPreview(dialog, filename);
  // The owner can still GET a trashed item, but the delivery is no longer available to receive.
  expect((await page.request.post(`/api/items/${id}/trash`, { headers })).ok()).toBe(true);
  await expectUnavailable(dialog, filename);
});
