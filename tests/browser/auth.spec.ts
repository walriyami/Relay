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
    expect(desktopSignIn.y).toBeLessThan(180);
    expect(Math.abs(desktopCode.y - desktopSignIn.y)).toBeLessThan(2);
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
    await expect(guest.getByRole("heading", { name: "Create your account" })).toBeVisible();
    await expect(guest.getByText(/^admin invited you to Relay\./)).toBeVisible();
    const username = guest.getByLabel("Username");
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
  await page.goto("/admin");
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
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/join/${token}`);
  const session = await page.request.get(api.session.get.path);
  expect(session.status()).toBe(401);
});
