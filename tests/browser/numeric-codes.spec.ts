import { test, expect } from "@playwright/test";
import { api } from "../../shared/api.ts";
import { BASE, composer, copyShareUrl, destinations, signedIn, unique, writeText } from "./helpers";

test("the deployment setting rotates open handoffs, updates every code field and preserves links", async ({
  page,
  browser,
}) => {
  await signedIn(page, "Numeric code admin");
  const session = await (await page.request.get(api.session.get.path)).json();
  const headers = { "X-Relay-CSRF": session.csrf };
  const setLength = async (codeLength: 4 | 6) => {
    const response = await page.request.patch(api.admin.settings.path, { headers, data: { codeLength } });
    expect(response.ok()).toBe(true);
  };
  await setLength(6);
  const admin = await page.context().newPage();
  const device = await page.context().newPage();
  const requestPage = await page.context().newPage();
  const invitePage = await page.context().newPage();
  const visitor = await browser.newContext({ baseURL: BASE });
  const guest = await visitor.newPage();
  try {
    const content = unique("numeric-share");
    await writeText(page, content);
    await destinations(page).getByRole("button", { name: "Create link" }).click();
    const handoff = page.locator(".transfer").first();
    const shareCode = handoff.locator(".share-access-code .code");
    await expect(shareCode).toHaveText(/^[0-9]{3}-[0-9]{3}$/);
    const oldCode = await shareCode.innerText();
    const shareUrl = await copyShareUrl(handoff);

    await device.goto("/settings");
    await device.getByRole("button", { name: "Add a device" }).click();
    const deviceHandoff = device.getByRole("dialog", { name: "Add a device" });
    await expect(deviceHandoff.locator(".share-access-code .code")).toHaveText(/^[0-9]{3}-[0-9]{3}$/);
    const deviceUrl = await copyShareUrl(deviceHandoff, "Copy sign-in link");
    expect(new URL(deviceUrl).searchParams.get("device")).toBeTruthy();

    const requestName = unique("numeric-request");
    await requestPage.goto("/requests");
    await requestPage.getByRole("button", { name: "New request" }).click();
    await requestPage.getByLabel("What are you asking for?").fill(requestName);
    await requestPage.getByRole("button", { name: "Create request" }).click();
    const requestHandoff = requestPage.getByRole("dialog", { name: requestName });
    const requestCode = requestHandoff.locator(".share-access-code .code");
    await expect(requestCode).toHaveText(/^[0-9]{3}-[0-9]{3}$/);
    const requestUrl = await copyShareUrl(requestHandoff);
    const oldRequestCode = await requestCode.innerText();

    await invitePage.goto("/admin");
    await invitePage.getByRole("button", { name: "Invite member" }).click();
    await invitePage.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
    const inviteHandoff = invitePage.getByRole("dialog", { name: "Invitation ready" });
    const inviteCode = inviteHandoff.locator(".share-access-code .code");
    await expect(inviteCode).toHaveText(/^[0-9]{3}-[0-9]{3}$/);
    const inviteUrl = await copyShareUrl(inviteHandoff);
    const oldInviteCode = await inviteCode.innerText();

    await guest.goto("/");
    await expect(guest.locator(".code-entry-field-slot")).toHaveCount(6);
    await admin.goto("/admin");
    await admin.getByRole("radio", { name: "4 digits · 1234" }).click();
    await admin.getByRole("button", { name: "Save code length" }).click();
    const confirmation = admin.getByRole("dialog", { name: "Use 4-digit codes?" });
    await expect(confirmation).toContainText("their links and QR codes will keep working");
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    expect((await (await page.request.get(api.pickup.config.path)).json()).codeLength).toBe(6);
    await admin.getByRole("button", { name: "Save code length" }).click();
    await confirmation.getByRole("button", { name: "Replace codes" }).click();
    await expect(admin.getByText("Code length saved. Existing codes replaced.")).toBeVisible();
    await expect(shareCode).toHaveText(/^[0-9]{4}$/);
    await expect(deviceHandoff.locator(".share-access-code .code")).toHaveText(/^[0-9]{4}$/);
    await expect(requestCode).toHaveText(/^[0-9]{4}$/);
    await expect(inviteCode).toHaveText(/^[0-9]{4}$/);
    expect(await copyShareUrl(handoff)).toBe(shareUrl);
    expect(await copyShareUrl(deviceHandoff, "Copy sign-in link")).toBe(deviceUrl);
    expect(await copyShareUrl(requestHandoff)).toBe(requestUrl);
    expect(await copyShareUrl(inviteHandoff)).toBe(inviteUrl);

    await guest.bringToFront();
    await guest.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(guest.locator(".code-entry-field-slot")).toHaveCount(4);
    const currentCode = await shareCode.innerText();
    await guest.getByRole("textbox", { name: "Code", exact: true }).fill(currentCode);
    await expect(guest).toHaveURL(shareUrl);
    await expect(guest.getByRole("region", { name: "Text" })).toContainText(content);
    await guest.goto("/pickup");
    await expect(guest.locator(".code-entry-field-slot")).toHaveCount(4);
    await guest.getByLabel("Pickup code").fill(currentCode);
    await expect(guest.getByRole("region", { name: "Text" })).toContainText(content);

    for (const [codeField, url] of [
      [requestCode, requestUrl],
      [inviteCode, inviteUrl],
    ] as const) {
      await guest.goto("/");
      await guest.getByRole("textbox", { name: "Code", exact: true }).fill(await codeField.innerText());
      await expect(guest).toHaveURL(url);
    }
    const currentInvite = await inviteCode.innerText();
    await inviteHandoff.getByRole("button", { name: "Done" }).click();
    const inviteRow = invitePage
      .getByRole("list", { name: "Open invitations" })
      .getByRole("listitem")
      .filter({ hasText: currentInvite });
    await expect(inviteRow.getByRole("button", { name: "Copy invitation code" })).toBeVisible();

    await page.getByRole("button", { name: "Enter code" }).click();
    await expect(page.getByRole("dialog", { name: "Enter a code" }).locator(".code-entry-field-slot")).toHaveCount(4);
    await page.keyboard.press("Escape");
    for (const code of [oldCode, oldRequestCode, oldInviteCode]) {
      const oldResponse = await visitor.request.post(api.pickup.resolve.path, { data: { code } });
      expect(oldResponse.status()).toBe(404);
    }
    await guest.goto(deviceUrl);
    await expect(composer(guest)).toBeVisible();
    await expect(deviceHandoff.getByRole("status").filter({ hasText: /is signed in\.$/ })).toBeVisible();

    await setLength(6);
    await expect(shareCode).toHaveText(/^[0-9]{3}-[0-9]{3}$/);
    expect(await shareCode.innerText()).not.toBe(oldCode);
    await expect(requestCode).toHaveText(/^[0-9]{3}-[0-9]{3}$/);
    expect(await requestCode.innerText()).not.toBe(oldRequestCode);
    await guest.goto(requestUrl);
    await expect(guest.getByText(requestName).first()).toBeVisible();
    await guest.goto(inviteUrl);
    await expect(guest.getByRole("heading", { name: "You’re signed in as admin" })).toBeVisible();
    await guest.goto(shareUrl);
    await expect(guest.getByRole("region", { name: "Text" })).toContainText(content);
  } finally {
    await setLength(6);
    await visitor.close();
    await admin.close();
    await device.close();
    await requestPage.close();
    await invitePage.close();
  }
});
