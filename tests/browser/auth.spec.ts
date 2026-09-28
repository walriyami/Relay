import { test, expect, type Page } from "@playwright/test";
import { api } from "../../shared/api.ts";
import { copyShareUrl, BASE, composer, signedIn } from "./helpers";

/** A fresh invitation link token, made from the admin page like an administrator would. */
async function inviteToken(page: Page) {
  await page.goto("/admin");
  await page.getByRole("button", { name: "Invite member" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
  const url = await copyShareUrl(page.getByRole("dialog"));
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  return new URL(url).pathname.split("/").at(-1)!;
}

test("a wrong password keeps focus in the password field, described by the error", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(/Incorrect username or password|Too many attempts/);
    const password = page.getByLabel("Password");
    await expect(password).toBeFocused();
    await expect(password).toHaveAttribute("aria-invalid", "true");
    await expect(password).toHaveAttribute("aria-describedby", "sign-in-error");
    expect(await password.evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!)).toBe(
      "not-the-password".length,
    );
  } finally {
    await context.close();
  }
});

test("sign-in moves focus into the app while the skip link remains available by keyboard", async ({
  browser,
  browserName,
}) => {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill("Browser-test-password-only");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(composer(page)).toBeVisible();
    await expect(page.locator("#main")).toBeFocused();
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toHaveCSS("top", "-60px");

    await page.reload();
    await expect(composer(page)).toBeVisible();
    // macOS WebKit uses Option+Tab to include links in keyboard navigation by default.
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(skip).toBeFocused();
    await expect(skip).toHaveCSS("top", "8px");
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  } finally {
    await context.close();
  }
});

test("the sign-in page accepts a prefilled add-device code and removes it from the address", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  try {
    await page.goto("/?login=234-567");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("Sign in on this device with the code from your other device.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Code" })).toHaveValue("234-567");
    await expect.poll(() => new URL(page.url()).search).toBe("");
    await expect(page.getByText(/choose Add a device on the Send page or in Settings › Devices/)).toBeVisible();
    await expect(page.getByLabel("Username")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("code entry has its own card beside sign-in and stacks below on a narrow screen", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto("/");
    const signIn = page.locator(".auth-card").first();
    const code = page.locator(".auth-code-card");
    await expect(signIn.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(code.getByRole("heading", { name: "Use a code" })).toBeVisible();
    const desktopSignIn = (await signIn.boundingBox())!;
    const desktopCode = (await code.boundingBox())!;
    expect(desktopCode.x).toBeGreaterThan(desktopSignIn.x + desktopSignIn.width);
    // Side by side, the pair is centred in the window like every other sign-in screen, and the
    // two cards share one height.
    expect(Math.abs(desktopCode.y - desktopSignIn.y)).toBeLessThan(2);
    expect(Math.abs(desktopCode.height - desktopSignIn.height)).toBeLessThan(2);
    const brand = (await page.locator(".auth-page-brand").boundingBox())!;
    expect(Math.abs(brand.y - (800 - (desktopSignIn.y + desktopSignIn.height)))).toBeLessThan(10);
    expect(Math.abs((desktopSignIn.x + desktopCode.x + desktopCode.width) / 2 - 600)).toBeLessThan(10);

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileSignIn = (await signIn.boundingBox())!;
    const mobileCode = (await code.boundingBox())!;
    expect(mobileCode.y).toBeGreaterThan(mobileSignIn.y + mobileSignIn.height);
    expect(mobileCode.x + mobileCode.width).toBeLessThanOrEqual(390);
  } finally {
    await context.close();
  }
});

test("an unusable invitation is a dead end without a form", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  try {
    await page.goto("/join/garbage-token");
    await expect(page.getByRole("heading", { name: "This invitation can’t be used" })).toBeVisible();
    await expect(page.getByText("Ask the person who invited you for a new link.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toHaveCount(0);
    await expect(page.getByLabel("Username")).toHaveCount(0);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("joining explains and enforces the username rule while typing", async ({ page, browser }) => {
  await signedIn(page);
  const token = await inviteToken(page);
  const context = await browser.newContext({ baseURL: BASE });
  const guest = await context.newPage();
  try {
    await guest.goto(`/join/${token}`);
    await expect(guest.getByRole("heading", { name: "You’re invited to Relay" })).toBeVisible();
    await expect(guest.getByText(/^admin invited you to join\./)).toBeVisible();
    await guest.getByRole("button", { name: "Accept invitation" }).click();
    await expect(guest.getByRole("heading", { name: "Create your account" })).toBeVisible();
    const username = guest.getByLabel("Username");
    await expect(username).toBeFocused();
    const hint = guest.locator("#join-username-hint");
    await expect(hint).toHaveText(
      "3–32 characters: lowercase letters, numbers, - and _, starting with a letter or number.",
    );
    await username.pressSequentially("Bo B");
    await expect(username).toHaveValue("bob");
    await expect(hint).toContainText("Spaces can’t be used in a username.");
    await username.fill("_x");
    await guest.getByLabel("Password", { exact: true }).fill("Browser-test-password-only");
    await guest.getByLabel("Confirm password").fill("Browser-test-password-only");
    await guest.getByRole("button", { name: "Create account" }).click();
    await expect(hint).toHaveText("Use at least 3 characters.");
    await expect(username).toBeFocused();
    await expect(username).toHaveAttribute("aria-invalid", "true");
  } finally {
    await context.close();
  }
  // Leave the invitation unused; it expires on its own. Withdraw it so the admin list stays short.
  await page.goto("/admin/members");
  const invitations = page.getByRole("region", { name: "Invitations" });
  const count = await invitations.getByRole("button", { name: "Withdraw" }).count();
  for (let i = 0; i < count; i++) {
    await invitations.getByRole("button", { name: "Withdraw" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Withdraw", exact: true }).click();
    await expect(invitations.getByRole("button", { name: "Withdraw" })).toHaveCount(count - i - 1);
  }
});

test("a dead invitation opened while signed in says so, without asking to sign out", async ({ page }) => {
  await signedIn(page, "Invitation holder");
  await page.goto("/join/not-a-real-invitation-token");
  await expect(page.getByRole("heading", { name: "This invitation can’t be used" })).toBeVisible();
  await expect(page.getByText("You’re still signed in as admin.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await page.getByRole("button", { name: "Go to Relay" }).click();
  await expect(composer(page)).toBeVisible();
});

test("an invitation opened while signed in says so and offers to sign out", async ({ page }) => {
  await signedIn(page, "Invitation holder");
  const token = await inviteToken(page);
  await page.goto(`/join/${token}`);
  await expect(page.getByRole("heading", { name: "You’re signed in as admin" })).toBeVisible();
  await expect(page.getByText("Sign out to use this invitation")).toBeVisible();
  await page.getByRole("button", { name: "Go to Relay" }).click();
  await expect(composer(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");

  // Signing out from the notice lands on the invitation itself.
  await page.goto(`/join/${token}`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "You’re invited to Relay" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/join/${token}`);
  const session = await page.request.get(api.session.get.path);
  expect(session.status()).toBe(401);
});

test("a new member is welcomed, makes Relay theirs and adds a device, picking up after a reload", async ({
  page,
  browser,
}) => {
  await signedIn(page);
  const token = await inviteToken(page);
  const context = await browser.newContext({ baseURL: BASE });
  const guest = await context.newPage();
  const username = `member-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await guest.goto(`/join/${token}`);
    await expect(guest.getByRole("heading", { name: "You’re invited to Relay" })).toBeVisible();
    await expect(guest.getByText(/^This invitation works once, until /)).toBeVisible();
    await guest.getByRole("button", { name: "Accept invitation" }).click();

    await guest.getByRole("button", { name: "Back" }).click();
    await expect(guest.getByRole("heading", { name: "You’re invited to Relay" })).toBeFocused();
    await guest.getByRole("button", { name: "Accept invitation" }).click();
    await guest.getByLabel("Username").fill(username);
    await guest.getByLabel("Password", { exact: true }).fill("Browser-test-password-only");
    await guest.getByLabel("Confirm password").fill("Browser-test-password-only");
    await guest.getByRole("button", { name: "Create account" }).click();

    // The account exists now; the address no longer holds the spent invitation.
    await expect(guest.getByRole("heading", { name: "Make it yours" })).toBeFocused();
    expect(new URL(guest.url()).pathname).toBe("/welcome");
    await expect(guest.getByRole("list", { name: "Joining steps" }).getByRole("listitem")).toHaveCount(3);

    // A reload picks up at the choices.
    await guest.reload();
    await expect(guest.getByRole("heading", { name: "Make it yours" })).toBeVisible();
    await expect(guest.getByText("Welcome back. A few choices are left.")).toBeVisible();

    await guest.getByLabel("Your name").fill("Grace");
    await guest
      .getByRole("radiogroup", { name: "Move uploads to Trash after" })
      .getByRole("radio", { name: "30 days" })
      .click();
    await guest.getByRole("radiogroup", { name: "Links expire after" }).getByRole("radio", { name: "30 days" }).click();
    await guest.getByRole("radiogroup", { name: "Empty Trash after" }).getByRole("radio", { name: "90 days" }).click();
    await guest.getByRole("button", { name: "Save and continue" }).click();

    // Adding a device shows a sign-in code, and says so when the other device uses it.
    await expect(guest.getByRole("heading", { name: "Add your other devices" })).toBeFocused();
    const created = guest.waitForResponse((response) => response.url().endsWith(api.loginCodes.create.path));
    await guest.getByRole("button", { name: "Add a device" }).click();
    const { code } = await (await created).json();
    await expect(guest.getByRole("button", { name: "Copy sign-in link" })).toBeVisible();
    const phone = await browser.newContext({ baseURL: BASE });
    try {
      const signIn = await phone.request.post(api.session.code.path, { data: { code, deviceName: "Grace’s phone" } });
      expect(signIn.ok()).toBe(true);
    } finally {
      await phone.close();
    }
    await expect(guest.getByText("Grace’s phone is signed in.")).toBeVisible();
    await expect(guest.getByRole("button", { name: "Continue" })).toBeFocused();
    await guest.getByRole("button", { name: "Continue" }).click();

    await expect(guest.getByRole("heading", { name: "You’re all set" })).toBeFocused();
    await expect(guest.getByText("Welcome to Relay, Grace.")).toBeVisible();
    await guest.getByRole("button", { name: "Start using Relay" }).click();
    await expect(composer(guest)).toBeVisible();
    expect(new URL(guest.url()).pathname).toBe("/");

    const me = await (await guest.request.get(api.session.get.path)).json();
    expect(me.user).toMatchObject({ username, name: "Grace", admin: false, retentionDays: 30, trashDays: 90 });
    expect(me.prefs).toMatchObject({ linkDays: 30 });
  } finally {
    await context.close();
  }
});

test("a new member can leave devices for later and keep every default", async ({ page, browser }) => {
  await signedIn(page);
  const token = await inviteToken(page);
  const context = await browser.newContext({ baseURL: BASE });
  const guest = await context.newPage();
  try {
    await guest.goto(`/join/${token}`);
    await guest.getByRole("button", { name: "Accept invitation" }).click();
    await guest.getByLabel("Username").fill(`member-${Math.random().toString(36).slice(2, 10)}`);
    await guest.getByLabel("Password", { exact: true }).fill("Browser-test-password-only");
    await guest.getByLabel("Confirm password").fill("Browser-test-password-only");
    await guest.getByRole("button", { name: "Create account" }).click();
    await expect(guest.getByRole("heading", { name: "Make it yours" })).toBeVisible();
    await expect(guest.getByText("Welcome back")).toHaveCount(0);

    // Nothing changed, so nothing is sent.
    let updates = 0;
    guest.on("request", (request) => {
      if (request.url().endsWith(api.account.update.path)) updates++;
    });
    await guest.getByRole("button", { name: "Save and continue" }).click();

    // A code that was shown but not used is withdrawn when the step is left.
    const created = guest.waitForResponse((response) => response.url().endsWith(api.loginCodes.create.path));
    await guest.getByRole("button", { name: "Add a device" }).click();
    const { code } = await (await created).json();
    const revoked = guest.waitForRequest(
      (request) => request.method() === "DELETE" && request.url().includes("/login-codes/"),
    );
    await guest.getByRole("button", { name: "I’ll do this later" }).click();
    await revoked;
    await expect(guest.getByRole("heading", { name: "You’re all set" })).toBeVisible();
    await expect(guest.getByText("Add your phone")).toBeVisible();
    expect(updates).toBe(0);
    const phone = await browser.newContext({ baseURL: BASE });
    try {
      const signIn = await phone.request.post(api.session.code.path, { data: { code, deviceName: "Too late" } });
      expect(signIn.ok()).toBe(false);
    } finally {
      await phone.close();
    }
  } finally {
    await context.close();
  }
});
