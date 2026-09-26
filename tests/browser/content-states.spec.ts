import { test, expect, type Page } from "@playwright/test";
import { BASE, copyShareUrl, deviceContext, signedIn, unique } from "./helpers";

async function folderItem(page: Page, pending = false) {
  const session = await (await page.request.get("/api/session")).json();
  const headers = { "X-Relay-CSRF": session.csrf };
  const name = unique("Empty folder");
  const response = await page.request.post("/api/transfers", {
    headers,
    data: {
      id: crypto.randomUUID(),
      tab: crypto.randomUUID(),
      name,
      text: pending ? "Already saved before the remaining upload is cancelled." : undefined,
      folders: ["Empty"],
      files: pending ? [{ path: "later.txt", size: 8, mime: "text/plain" }] : [],
    },
  });
  expect(response.ok()).toBeTruthy();
  const transfer = await response.json();
  if (!pending)
    expect(
      (
        await page.request.post(`/api/transfers/${transfer.id}/complete`, {
          headers,
          data: { destination: { kind: "save" } },
        })
      ).ok(),
    ).toBeTruthy();
  return { ...transfer, headers, name };
}

async function downloadZip(page: Page, name: string) {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
}

test("an empty folder has a meaningful view and downloads from Files and a public share", async ({ page, browser }) => {
  await signedIn(page);
  const item = await folderItem(page);
  await page.goto(`/files/${item.itemId}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("This folder is empty", { exact: true })).toBeVisible();
  await downloadZip(page, "Download ZIP");
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  const share = page.getByRole("dialog").last();
  const url = await copyShareUrl(share);
  const guest = await browser.newContext({ baseURL: BASE });
  try {
    const receiver = await guest.newPage();
    await receiver.goto(url);
    await expect(receiver.getByText("This folder is empty", { exact: true })).toBeVisible();
    await downloadZip(receiver, "Download all");
  } finally {
    await guest.close();
  }
  await share.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: `Actions for ${item.name}`, exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Download ZIP", exact: true })).toBeVisible();
});

test("unfinished saved content explains why sharing and sending must wait", async ({ page, browser }) => {
  await signedIn(page);
  const phoneName = unique("Readiness phone");
  const phone = await deviceContext(browser, phoneName);
  try {
    const item = await folderItem(page, true);
    await page.goto(`/files/${item.itemId}`);
    const dialog = page.getByRole("dialog");
    const waiting = dialog.getByText("Wait for the uploads to finish before sharing or sending.", { exact: true });
    await expect(waiting).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Share", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Download ZIP" })).toBeEnabled();
    await dialog.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: /^Send to / })).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect((await page.request.post(`/api/transfers/${item.id}/cancel`, { headers: item.headers })).ok()).toBeTruthy();
    await expect(dialog.getByRole("button", { name: "Share", exact: true })).toBeEnabled();
    await expect(waiting).toHaveCount(0);
    await dialog.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: `Send to ${phoneName}`, exact: true })).toBeVisible();
  } finally {
    await phone.context.close();
  }
});

test("an empty-folder delivery downloads automatically and can be downloaded again", async ({ page, browser }) => {
  await signedIn(page);
  const phone = await deviceContext(browser, "Care folder phone");
  try {
    const item = await folderItem(page);
    const session = await (await phone.page.request.get("/api/session")).json();
    const download = phone.page.waitForEvent("download");
    expect(
      (
        await page.request.post("/api/deliveries", {
          headers: item.headers,
          data: { id: crypto.randomUUID(), item: item.itemId, device: session.device.id },
        })
      ).ok(),
    ).toBeTruthy();
    expect((await download).suggestedFilename()).toMatch(/\.zip$/);
    const dialog = phone.page.getByRole("dialog");
    await expect(dialog.getByText("This folder is empty", { exact: true })).toBeVisible();
    await expect(dialog).toContainText("Accepted on this device");
    await downloadZip(phone.page, "Download ZIP");
  } finally {
    await phone.context.close();
  }
});
