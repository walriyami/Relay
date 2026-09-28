import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { api } from "../../shared/api.ts";
import type { User } from "../../shared/model.ts";
import { copyShareUrl, BASE, composer, signedIn, unique } from "./helpers";

const MB = 1024 ** 2;

async function inviteToken(page: Page) {
  await page.goto("/admin/members");
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
      return (await response.json()).user as User;
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
  await page.goto("/admin/members");
  const note = unique("Sam");
  await page.getByRole("button", { name: "Invite member" }).click();
  await page.getByRole("dialog").getByLabel("Who is it for?").fill(note);
  await page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
  await expect(page.getByRole("dialog").getByRole("img", { name: "QR code for this invitation" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  const row = page.getByRole("list", { name: "Open invitations" }).getByRole("listitem").filter({ hasText: note });
  await expect(row.locator("strong")).toHaveText(`For ${note}`);
  await row.getByRole("button", { name: "Withdraw" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Withdraw" }).click();
  await expect(row).toHaveCount(0);
});

test("a member with a sub-GB storage limit can be managed and suspended, and their open tab ends at once", async ({
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

    const limits = { storage: 50 * MB, keepDays: null, linkDays: null };
    await adminPatch(page, `/api/admin/members/${user.id}`, { limits, expectedLimits: user.limits });
    await page.goto("/admin/members");
    await page.getByRole("button", { name: `Manage ${username}` }).click();
    const dialog = page.getByRole("dialog", { name: `Manage ${username}` });
    await expect(
      dialog.getByRole("radiogroup", { name: "Storage limit" }).getByRole("radio", { name: "Other" }),
    ).toBeChecked();
    await expect(dialog.getByRole("spinbutton", { name: /^Other storage limit/ })).toHaveValue("50");
    await expect(dialog.getByRole("combobox", { name: "Other storage limit unit" })).toHaveValue(String(MB));
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

    // Only the changed field was sent, so the 50 MB limit was never rewritten.
    expect(updates).toEqual([{ disabled: true }]);
    const row = page.getByRole("listitem").filter({ hasText: username });
    await expect(row.getByText("Suspended")).toBeVisible();
    await expect(row).toContainText("of 50 MB");

    // Turn access back on and change the limit in another unit.
    await page.getByRole("button", { name: `Manage ${username}` }).click();
    await dialog.getByRole("switch", { name: /Suspend access/ }).uncheck();
    await dialog.getByRole("spinbutton", { name: /^Other storage limit/ }).fill("1.5");
    await dialog.getByRole("combobox", { name: "Other storage limit unit" }).selectOption({ label: "GB" });
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText("of 1.5 GB");
    expect(updates.at(-1)).toEqual({
      limits: { ...limits, storage: 1.5 * 1024 ** 3 },
      expectedLimits: limits,
      disabled: false,
    });
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
    await page.goto("/admin/members");
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
  await page.goto("/admin/members");
  const invitations = page.getByRole("region", { name: "Invitations" });
  // Counted once the list has loaded, not while it is still on its way.
  await expect(invitations.getByRole("button", { name: "Withdraw" }).first()).toBeVisible();
  const before = await invitations.getByRole("button", { name: "Withdraw" }).count();
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

test("the overview shows what is stored and moving, without exposing recovery controls", async ({ page }) => {
  await signedIn(page);
  await page.goto("/admin");
  const tabs = page.getByRole("navigation", { name: "Admin" });
  await expect(tabs.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("listitem").filter({ hasText: "Saved" }).first()).toBeVisible();
  const storage = page.getByRole("region", { name: "Storage", exact: true });
  await expect(storage.getByText(/^(None|\d+ uploads?)$/)).toBeVisible();
  await expect(page.getByRole("group", { name: /^Data moved each day, by everyone/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "By member" })).toContainText("admin");
  await expect(page.getByRole("region", { name: "Service health" })).toBeVisible();

  // Periods switch in place; the other tabs keep their own addresses.
  await page.getByRole("radio", { name: "12 months" }).click();
  await expect(page.getByRole("group", { name: /^Data moved each month, by everyone/ })).toBeVisible();
  await tabs.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(page.getByRole("region", { name: "Total storage" })).toBeVisible();
  await expect(page.getByText(/backup/i)).toHaveCount(0);
});

test("the administrator can continue bounded integrity checks and retry a failed batch", async ({ page }) => {
  await signedIn(page);
  await page.goto("/admin");
  const cursor = "a".repeat(64);
  const bodies: unknown[] = [];
  let lastResult: object | null = null;
  await page.route("**/api/admin", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.integrity.lastResult = lastResult;
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/admin/integrity", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 2)
      return route.fulfill({ status: 503, json: { error: "Storage is temporarily unavailable." } });
    lastResult = {
      checked: 2,
      bytes: 1000,
      missing: 0,
      corrupt: 0,
      errors: 0,
      cancelled: false,
      complete: bodies.length === 3,
      nextAfter: bodies.length === 3 ? null : cursor,
      started: Date.now(),
      finished: Date.now(),
    };
    await route.fulfill({ status: 202, json: { running: true } });
  });
  await page.getByRole("button", { name: "Check stored files", exact: true }).click();
  await expect(page.getByText(/Last batch:.*More files remain/)).toBeVisible();
  await page.getByRole("button", { name: "Continue file check" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Storage is temporarily unavailable." })).toBeVisible();
  await page.getByRole("button", { name: "Continue file check" }).click();
  await expect(page.getByText(/Last batch:.*Check finished/)).toBeVisible();
  expect(bodies).toEqual([{}, { after: cursor }, { after: cursor }]);
  await expect(page.getByRole("button", { name: "Check stored files", exact: true })).toBeEnabled();
});

test("an accepted integrity scan failure stays visible until a successful retry", async ({ page }) => {
  await signedIn(page);
  let attempts = 0;
  await page.route("**/api/admin", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.integrity.lastError = attempts === 1;
    data.integrity.running = false;
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/admin/integrity", async (route) => {
    attempts++;
    await route.fulfill({ status: 202, json: { running: true } });
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Check stored files", exact: true }).click();
  const failure = page.getByRole("alert").filter({ hasText: "The file check could not finish." });
  await expect(failure).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Service health" }).getByText("Needs attention", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check stored files", exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Service health" }).getByText("No active alerts", { exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

test("the administrator renames a member and limits their links, sending only what changed", async ({
  page,
  browser,
}) => {
  await signedIn(page);
  const token = await inviteToken(page);
  const username = unique("erin").toLowerCase();
  const memberContext = await browser.newContext({ baseURL: BASE });
  try {
    const user = await join(memberContext, token, username, "Erin laptop");
    await page.goto("/admin/members");
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
    await dialog
      .getByRole("radiogroup", { name: "Links work at most" })
      .getByRole("radio", { name: "30 days" })
      .click();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    // Tightening says what it does to what they already have before it happens.
    const confirm = page.getByRole("dialog", { name: /^Tighten .*limits\?$/ });
    await expect(confirm).toContainText(
      "shared links and upload-request URLs that would work longer now expire within 30 days",
    );
    await confirm.getByRole("button", { name: "Tighten limits" }).click();
    await expect(dialog).toHaveCount(0);
    const limits = { storage: null, keepDays: null, linkDays: 30 };
    expect(updates.at(-1)).toEqual({ name: "Erin Quinn", username: renamed, limits, expectedLimits: user.limits });

    const row = page.getByRole("listitem").filter({ hasText: renamed });
    await expect(row).toContainText("Erin Quinn");
    await expect(row).toContainText("links up to 30 days");
    const me = await (await memberContext.request.get(api.session.get.path)).json();
    expect(me.user).toMatchObject({ name: "Erin Quinn", username: renamed, limits });
    expect(me.prefs.linkDays).toBeLessThanOrEqual(30);
  } finally {
    await memberContext.close();
  }
});

test("an invitation's limits are folded away until added, and can change until it is used", async ({ page }) => {
  await signedIn(page);
  await page.goto("/admin/members");
  const writes: { method: string; body: object }[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/admin/invites") && req.method() !== "GET")
      writes.push({ method: req.method(), body: req.postDataJSON() });
  });
  const note = unique("Limited");
  await page.getByRole("button", { name: "Invite member" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite a member" });
  await expect(dialog).toContainText("No limits.");
  await dialog.getByLabel("Who is it for?").fill(note);
  await dialog.getByRole("button", { name: "Add limits" }).click();
  await dialog.getByRole("radiogroup", { name: "Storage limit" }).getByRole("radio", { name: "10 GB" }).click();
  await dialog.getByRole("radiogroup", { name: "Links work at most" }).getByRole("radio", { name: "7 days" }).click();
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  const ready = page.getByRole("dialog", { name: "Invitation ready" });
  await expect(ready).toContainText("10 GB storage · links up to 7 days");
  await ready.getByRole("button", { name: "Done" }).click();
  const limits = { storage: 10 * 1024 ** 3, keepDays: null, linkDays: 7 };
  expect(writes).toEqual([{ method: "POST", body: { note, limits } }]);

  const row = page.getByRole("list", { name: "Open invitations" }).getByRole("listitem").filter({ hasText: note });
  await expect(row).toContainText("10 GB storage · links up to 7 days");
  await row.getByRole("button", { name: `Edit invitation for ${note}` }).click();
  const edit = page.getByRole("dialog", { name: "Edit invitation" });
  await expect(
    edit.getByRole("radiogroup", { name: "Storage limit" }).getByRole("radio", { name: "10 GB" }),
  ).toBeChecked();
  await edit.getByRole("button", { name: "Remove limits" }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  await expect(row).toContainText("No limits");
  expect(writes.at(-1)).toEqual({
    method: "PATCH",
    body: { note, limits: { storage: null, keepDays: null, linkDays: null }, expectedLimits: limits },
  });

  await row.getByRole("button", { name: "Withdraw" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(row).toHaveCount(0);
});
