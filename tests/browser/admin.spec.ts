import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { api } from "../../shared/api.ts";
import { copyShareUrl, BASE, composer, signedIn, unique } from "./helpers";

const MB = 1024 ** 2;

async function inviteToken(page: Page) {
  await page.goto("/admin");
  await page.getByRole("button", { name: "Invite member" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
  const url = await copyShareUrl(page.getByRole("dialog"));
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  return new URL(url).pathname.split("/").at(-1)!;
}

/** Joins with an invitation, waiting out the sign-in rate limit that joins share. */
async function join(context: BrowserContext, token: string, username: string, deviceName: string) {
  for (let attempt = 0; ; attempt++) {
    const response = await context.request.post(api.session.join.path, {
      data: { token, username, password: "Browser-test-password-only", deviceName },
    });
    if (response.status() !== 429 || attempt > 6) {
      expect(response.ok()).toBe(true);
      return (await response.json()).user as { id: string };
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

/** An administrator API write from the admin page's own session. */
async function adminPatch(page: Page, path: string, data: object) {
  const session = await (await page.request.get(api.session.get.path)).json();
  const response = await page.request.patch(path, { data, headers: { "X-Relay-CSRF": session.csrf } });
  expect(response.ok()).toBe(true);
}

test("an invitation can say who it is for, so open invitations can be told apart", async ({ page }) => {
  await signedIn(page);
  await page.goto("/admin");
  const note = unique("Sam");
  await page.getByRole("button", { name: "Invite member" }).click();
  await page.getByRole("dialog").getByLabel("Who is it for? (optional)").fill(note);
  await page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
  await expect(page.getByRole("dialog").getByRole("img", { name: "QR code for this invitation" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  const row = page.getByRole("list", { name: "Open invitations" }).getByRole("listitem").filter({ hasText: note });
  await expect(row.locator("strong")).toHaveText(`For ${note}`);
  await row.getByRole("button", { name: "Withdraw" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Withdraw" }).click();
  await expect(row).toHaveCount(0);
});

test("a member with a sub-GB quota can be managed and suspended, and their open tab ends at once", async ({
  page,
  browser,
}) => {
  await signedIn(page);
  const token = await inviteToken(page);
  const username = unique("carol").toLowerCase();
  const memberContext = await browser.newContext({ baseURL: BASE });
  const memberPage = await memberContext.newPage();
  try {
    const user = await join(memberContext, token, username, "Carol laptop");
    await memberPage.goto("/");
    await expect(composer(memberPage)).toBeVisible();

    // A member opening the admin page gets the not-found page with a way back.
    await memberPage.goto("/admin");
    await expect(memberPage.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(memberPage).toHaveTitle("Relay");
    await memberPage.getByRole("button", { name: "Go to Send" }).click();
    await expect(composer(memberPage)).toBeVisible();

    await adminPatch(page, `/api/admin/members/${user.id}`, { quota: 50 * MB });
    await page.goto("/admin");
    await page.getByRole("button", { name: `Manage ${username}` }).click();
    const dialog = page.getByRole("dialog", { name: `Manage ${username}` });
    await expect(dialog.getByRole("spinbutton", { name: /^Storage quota/ })).toHaveValue("50");
    await expect(dialog.getByRole("combobox", { name: "Storage quota unit" })).toHaveValue(String(MB));
    await expect(dialog.getByRole("button", { name: "Save changes" })).toBeDisabled();

    const updates: object[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes(`/api/admin/members/${user.id}`))
        updates.push(req.postDataJSON());
    });
    await dialog.getByRole("switch", { name: /Suspend access/ }).check();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    const confirm = page.getByRole("dialog", { name: `Suspend ${username}?` });
    await expect(confirm).toContainText("signed out on 1 device");
    await confirm.getByRole("button", { name: "Suspend", exact: true }).click();

    // The open tab learns at once, without navigating.
    await expect(memberPage.getByText("Your account was suspended by the administrator.")).toBeVisible();
    await expect(memberPage.getByRole("heading", { name: "Sign in" })).toBeVisible();

    // Only the changed field was sent, so the 50 MB quota was never rewritten.
    expect(updates).toEqual([{ disabled: true }]);
    const row = page.getByRole("listitem").filter({ hasText: username });
    await expect(row.getByText("Suspended")).toBeVisible();
    await expect(row).toContainText("of 50 MB");

    // Turn access back on and change the quota in another unit.
    await page.getByRole("button", { name: `Manage ${username}` }).click();
    await dialog.getByRole("switch", { name: /Suspend access/ }).uncheck();
    await dialog.getByRole("spinbutton", { name: /^Storage quota/ }).fill("1.5");
    await dialog.getByRole("combobox", { name: "Storage quota unit" }).selectOption({ label: "GB" });
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText("of 1.5 GB");
    expect(updates.at(-1)).toEqual({ quota: 1.5 * 1024 ** 3, disabled: false });
  } finally {
    await memberContext.close();
  }
});

test("setting a member's password asks first and names what it signs out", async ({ page, browser }) => {
  await signedIn(page);
  const token = await inviteToken(page);
  const username = unique("dora").toLowerCase();
  const memberContext = await browser.newContext({ baseURL: BASE });
  try {
    await join(memberContext, token, username, "Dora phone");
    await page.goto("/admin");
    await page.getByRole("button", { name: `Manage ${username}` }).click();
    const dialog = page.getByRole("dialog", { name: `Manage ${username}` });
    await dialog.getByLabel("Set a new password").fill("Another-browser-password");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    const confirm = page.getByRole("dialog", { name: `Set a new password for ${username}?` });
    await expect(confirm).toContainText("signed out on 1 device");
    await expect(confirm).toContainText("passkeys are removed");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeVisible();
    expect((await memberContext.request.get(api.session.get.path)).status()).toBe(200);
  } finally {
    await memberContext.close();
  }
});

test("open invitations are listed and can be withdrawn", async ({ page, browser }) => {
  await signedIn(page);
  const token = await inviteToken(page);
  const invitations = page.getByRole("region", { name: "Invitations" });
  const before = await invitations.getByRole("button", { name: "Withdraw" }).count();
  expect(before).toBeGreaterThan(0);
  // The newest invitation is listed first.
  await invitations.getByRole("button", { name: "Withdraw" }).first().click();
  await page
    .getByRole("dialog", { name: "Withdraw this invitation?" })
    .getByRole("button", { name: "Withdraw", exact: true })
    .click();
  await expect(invitations.getByRole("button", { name: "Withdraw" })).toHaveCount(before - 1);

  const context = await browser.newContext({ baseURL: BASE });
  const guest = await context.newPage();
  try {
    await guest.goto(`/join/${token}`);
    await expect(guest.getByRole("heading", { name: "This invitation can’t be used" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("the admin page reports uploads without exposing recovery controls", async ({ page }) => {
  await signedIn(page);
  await page.goto("/admin");
  await expect(page.getByText(/^(No uploads right now|\d+ uploads? in progress)$/)).toBeVisible();
  await expect(page.getByText(/backup/i)).toHaveCount(0);
});

test("the administrator renames a member and changes their Trash, sending only what changed", async ({
  page,
  browser,
}) => {
  await signedIn(page);
  const token = await inviteToken(page);
  const username = unique("erin").toLowerCase();
  const memberContext = await browser.newContext({ baseURL: BASE });
  try {
    const user = await join(memberContext, token, username, "Erin laptop");
    await page.goto("/admin");
    await page.getByRole("button", { name: `Manage ${username}` }).click();
    const dialog = page.getByRole("dialog", { name: `Manage ${username}` });
    const updates: object[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes(`/api/admin/members/${user.id}`))
        updates.push(req.postDataJSON());
    });

    // A username someone else has is refused, and the field says so.
    await dialog.getByLabel("Username").fill("admin");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByLabel("Username")).toBeFocused();

    const renamed = `${username}-q`;
    await dialog.getByLabel("Name", { exact: true }).fill("Erin Quinn");
    await dialog.getByLabel("Username").fill(renamed.toUpperCase());
    await dialog.getByRole("radiogroup", { name: "Empty Trash after" }).getByRole("radio", { name: "7 days" }).click();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toHaveCount(0);
    expect(updates.at(-1)).toEqual({ name: "Erin Quinn", username: renamed, trashDays: 7 });

    const row = page.getByRole("listitem").filter({ hasText: renamed });
    await expect(row).toContainText("Erin Quinn");
    const me = await (await memberContext.request.get(api.session.get.path)).json();
    expect(me.user).toMatchObject({ name: "Erin Quinn", username: renamed, trashDays: 7 });
  } finally {
    await memberContext.close();
  }
});

test("defaults for new members save only what changed", async ({ page }) => {
  await signedIn(page);
  await page.goto("/admin");
  const section = page.getByRole("region", { name: "New members" });
  const save = section.getByRole("button", { name: "Save for new members" });
  await expect(save).toBeDisabled();
  const writes: object[] = [];
  page.on("request", (req) => {
    if (req.method() === "PATCH" && req.url().endsWith("/api/admin/settings")) writes.push(req.postDataJSON());
  });
  const trash = section.getByRole("radiogroup", { name: "Empty Trash after" });
  const current = trash.getByRole("radio", { checked: true });
  const before = await current.textContent();
  const next = before === "90 days" ? "30 days" : "90 days";
  await trash.getByRole("radio", { name: next }).click();
  await save.click();
  await expect(page.getByText("Saved. New members start with these.")).toBeVisible();
  expect(writes).toEqual([{ defaults: { trashDays: Number.parseInt(next) } }]);
  await expect(save).toBeDisabled();
  await expect(trash.getByRole("radio", { name: next })).toBeChecked();
});
