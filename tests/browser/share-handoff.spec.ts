import { expect, test } from "@playwright/test";
import { BASE, copyShareUrl, destinations, fileInput, signedIn, textFile, unique } from "./helpers";

test("a file link stays scannable, updates its expiry, and closes when turned off", async ({ page }) => {
  await signedIn(page);
  const name = unique("share-handoff");
  await fileInput(page).setInputFiles([textFile(`${name}.txt`)]);
  await destinations(page).getByRole("button", { name: "Create link" }).click();
  const result = page.locator(".transfer").first();
  await expect(result.getByRole("img", { name: "QR code for this link" })).toBeVisible();
  await expect(result.getByRole("button", { name: "Copy link" })).toBeVisible();
  await expect(result.locator(".share-access-code .code")).toHaveText(/^[0-9]{3}-[0-9]{3}$/);

  await page.getByRole("link", { name: "Links" }).click();
  const row = page.getByRole("list", { name: "Active links" }).getByRole("listitem").filter({ hasText: name });
  await row.getByRole("button", { name: "Share", exact: true }).click();
  const share = page.getByRole("dialog", { name: new RegExp(name) });
  await expect(share.getByRole("img", { name: "QR code for this file share" })).toBeVisible();
  await share.getByRole("button", { name: "Link settings" }).click();
  const expiry = page.getByRole("dialog", { name: "Link settings" });
  await expiry.getByRole("radio", { name: "30 days" }).click();
  await expiry.getByRole("button", { name: "Save" }).click();
  await expect(expiry).toHaveCount(0);
  await expect(share).toContainText("Expires in 30 days");

  await share.getByRole("button", { name: "Turn off link" }).click();
  await page
    .getByRole("dialog", { name: "Turn off this link?" })
    .getByRole("button", { name: "Turn off link" })
    .click();
  await expect(share).toHaveCount(0);
  await expect(row).toHaveCount(0);
});

test("a blocked clipboard gives a usable alternative for a hidden link", async ({ page }) => {
  await signedIn(page);
  await fileInput(page).setInputFiles([textFile(`${unique("copy-failure")}.txt`)]);
  await destinations(page).getByRole("button", { name: "Create link" }).click();
  const result = page.locator(".transfer").first();
  await expect(result.getByRole("img", { name: "QR code for this link" })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    document.execCommand = () => false;
  });
  await result.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByText("Couldn’t copy this link. Scan the QR code with another device.")).toBeVisible();
});

test("requests and invitations show every handoff method and their codes open the right route", async ({ page }) => {
  await signedIn(page);
  const visitor = await page.context().browser()!.newContext({ baseURL: BASE });
  const guest = await visitor.newPage();
  const name = unique("pickup-request");
  await page.getByRole("link", { name: "Requests" }).click();
  await page.getByRole("button", { name: "New request" }).click();
  await page.getByLabel("What are you asking for?").fill(name);
  await page.getByRole("button", { name: "Create request" }).click();
  const request = page.getByRole("dialog", { name });
  await expect(request.getByRole("img", { name: "QR code for this upload request" })).toBeVisible();
  const requestCode = await request.locator(".share-access-code .code").innerText();
  expect(requestCode).toMatch(/^[0-9]{3}-[0-9]{3}$/);
  expect(new URL(await copyShareUrl(request)).pathname).toMatch(/^\/r\//);
  await expect(request).not.toContainText(new URL(page.url()).host);
  await guest.goto("/");
  await guest.getByRole("textbox", { name: "Code" }).fill(requestCode);
  await expect(guest).toHaveURL(/\/r\//);
  await expect(guest.getByText(name).first()).toBeVisible();

  await page.goto("/admin");
  await page.getByRole("button", { name: "Invite member" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
  const invitation = page.getByRole("dialog", { name: "Invitation ready" });
  await expect(invitation.getByRole("img", { name: "QR code for this invitation" })).toBeVisible();
  const inviteCode = await invitation.locator(".share-access-code .code").innerText();
  expect(inviteCode).toMatch(/^[0-9]{3}-[0-9]{3}$/);
  expect(new URL(await copyShareUrl(invitation)).pathname).toMatch(/^\/join\//);
  await expect(invitation).not.toContainText(new URL(page.url()).host);
  await guest.goto("/");
  await guest.getByRole("textbox", { name: "Code" }).fill(inviteCode);
  await expect(guest).toHaveURL(/\/join\//);
  await visitor.close();
});

test("a library item fills its window with the preview and keeps its actions in the footer", async ({ page }) => {
  await signedIn(page);
  const name = unique("file-first");
  await fileInput(page).setInputFiles([textFile(`${name}.txt`, "The file stays in view.")]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await page
    .getByRole("list", { name: "Recent" })
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  const item = page.getByRole("dialog", { name: new RegExp(name) });
  await expect(item.getByRole("region", { name: `Preview of ${name}.txt` })).toContainText("The file stays in view.");
  const actions = item.locator(".modal-foot");
  await expect(actions.getByRole("button", { name: "Download" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Share" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "More actions" })).toBeVisible();
  await actions.getByRole("button", { name: "Share" }).click();
  const handoff = page.getByRole("dialog").last();
  await expect(handoff.getByRole("img", { name: "QR code for this file share" })).toBeVisible();
  await expect(handoff.locator(".share-access-code .code")).toHaveText(/^[0-9]{3}-[0-9]{3}$/);
  await expect(handoff.getByRole("button", { name: "Copy link" })).toBeVisible();
  await handoff.getByRole("button", { name: "Done" }).click();
  await expect(item.getByRole("region", { name: `Preview of ${name}.txt` })).toBeVisible();
});
