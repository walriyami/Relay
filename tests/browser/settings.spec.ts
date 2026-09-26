import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { BASE, composer, destinations, signedIn, writeText } from "./helpers";

test("settings save and apply to new shares", async ({ page }) => {
  await signedIn(page);
  await page.getByRole("button", { name: /^Account/ }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const expiry = page.getByRole("radiogroup", { name: "Links expire after" });
  await expiry.getByRole("radio", { name: "30 days" }).click();
  await expect(page.getByText("Saved").first()).toBeVisible();
  await page.reload();
  await expect(expiry.getByRole("radio", { name: "30 days" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("link", { name: "Send" }).click();
  await writeText(page, "something to send");
  await expect(destinations(page).getByRole("button", { name: /^Link options/ })).toHaveAccessibleName(
    "Link options: 30 days",
  );
  // Put the default back for other tests.
  await page.goto("/settings");
  await expiry.getByRole("radio", { name: "7 days" }).click();
  await expect(expiry.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");
});

test("passkeys can be managed where the browser supports them", async ({ page }) => {
  await signedIn(page);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Passkeys" });
  if (!(await page.evaluate(() => typeof window.PublicKeyCredential === "function"))) {
    await expect(section).toHaveCount(0);
    return;
  }
  await expect(section).toBeVisible();
  await expect(section.getByText("No passkeys added")).toBeVisible();
  await expect(section.getByRole("button", { name: "Add a passkey" })).toBeEnabled();
});

test("a six-digit sign-in code opens automatically from a code link", async ({ page, browser }) => {
  await signedIn(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Add a device" }).click();
  const code = (await page.locator(".share-access-code .code").textContent())!.trim();
  expect(code).toMatch(/^[0-9]{3}-[0-9]{3}$/);
  const unrelated = await browser.newContext({ baseURL: BASE });
  const signed = await unrelated.request.post("/api/session/password", {
    data: { username: "admin", password: "Browser-test-password-only", deviceName: "Unrelated browser" },
  });
  expect(signed.ok()).toBe(true);
  await page.waitForTimeout(3500);
  await expect(page.locator(".share-access-code .code")).toHaveText(code);
  await expect(page.getByRole("dialog").getByText(/is signed in\.$/)).toHaveCount(0);
  const other = await browser.newContext({ baseURL: BASE });
  const phone = await other.newPage();
  await phone.goto(`/?login=${encodeURIComponent(code)}`);
  await expect.poll(() => new URL(phone.url()).search).toBe("");
  await expect(composer(phone)).toBeVisible();
  // It names the new device and stays until Done, so there is time to read it.
  const success = page
    .getByRole("dialog")
    .getByRole("status")
    .filter({ hasText: /is signed in\.$/ });
  await expect(success).toBeVisible();
  await expect(success).not.toHaveText("The new device is signed in.");
  await page.waitForTimeout(2000);
  await expect(success).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await other.close();
  await unrelated.close();
});

test("add-device code creation failure offers a retry and then shows the QR", async ({ page }) => {
  await signedIn(page);
  await page.goto("/settings");
  let fail = true;
  await page.route("**/api/pickup/current", (route) => route.fulfill({ json: { code: "234-567" } }));
  await page.route("**/api/login-codes", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    if (fail) {
      fail = false;
      await route.fulfill({ status: 503, json: { error: "Temporarily unavailable." } });
    } else {
      await route.fulfill({
        json: {
          id: "retry-code",
          code: "234-567",
          token: "fixture-device-token",
          expires: Date.now() + 300_000,
          expiresIn: 300_000,
        },
      });
    }
  });
  await page.route("**/api/login-codes/retry-code/status", (route) => route.fulfill({ json: { state: "pending" } }));
  await page.getByRole("button", { name: "Add a device" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a device" });
  await expect(dialog.getByText("Temporarily unavailable.")).toBeVisible();
  await expect(dialog.getByText("Creating a code…")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog.getByRole("img", { name: "QR code for this device sign-in" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy sign-in link" })).toBeVisible();
});

const axeClean = async (page: Page) => {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};

for (const path of ["/", "/files", "/trash", "/links", "/requests", "/settings", "/admin"]) {
  test(`no accessibility problems on ${path}`, async ({ page }) => {
    await signedIn(page);
    await page.goto(path);
    await page.waitForLoadState("networkidle").catch(() => {});
    await axeClean(page);
  });
}

test("no accessibility problems with an item popup open", async ({ page }) => {
  await signedIn(page);
  await writeText(page, "axe popup check");
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await page
    .getByRole("list", { name: "Recent" })
    .locator(".collection-card")
    .first()
    .getByRole("button")
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForLoadState("networkidle").catch(() => {});
  await axeClean(page);
});

test("adding a passkey requires the current password before a verified ceremony", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Virtual authenticator uses CDP");
  await signedIn(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a passkey" });
  await dialog.getByLabel(/^Name/).fill("Verified browser key");
  await dialog.getByLabel("Current password").fill("wrong-password");
  const rejected = page.waitForResponse("**/api/account/passkeys/options");
  await dialog.getByRole("button", { name: "Continue" }).click();
  expect((await rejected).ok()).toBe(false);
  await expect(dialog.getByRole("alert")).toContainText(/password/i);
  expect((await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials).toHaveLength(0);
  await dialog.getByLabel("Current password").fill("Browser-test-password-only");
  const optionsResponse = page.waitForResponse("**/api/account/passkeys/options");
  await dialog.getByRole("button", { name: "Continue" }).click();
  const options = await (await optionsResponse).json();
  expect(options.options.authenticatorSelection.userVerification).toBe("required");
  await expect(dialog).toHaveCount(0);
  const section = page.getByRole("region", { name: "Passkeys" });
  await expect(section.getByText("Verified browser key", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Actions for Verified browser key" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(section.getByText("Verified browser key", { exact: true })).toHaveCount(0);
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
});

for (const scenario of ["expired", "revoked", "late response"] as const) {
  test(`a ${scenario} device code never claims a successful sign-in`, async ({ page }) => {
    await signedIn(page);
    await page.goto("/settings");
    await page.clock.install();
    let polls = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/pickup/current", (route) => route.fulfill({ json: { code: "234-567" } }));
    await page.route("**/api/login-codes", async (route) => {
      await route.fulfill({
        json: {
          id: "test-code",
          code: "234-567",
          token: "fixture-device-token",
          expires: await page.evaluate(() => Date.now() + 5000),
          expiresIn: 5000,
        },
      });
    });
    await page.route("**/api/login-codes/*/status", async (route) => {
      polls++;
      if (scenario === "late response") await held;
      await route.fulfill({ json: { state: scenario === "revoked" ? "gone" : "pending" } });
    });
    await page.getByRole("button", { name: "Add a device" }).click();
    if (scenario !== "revoked") await expect(page.locator(".share-access-code .code")).toHaveText("234-567");
    await expect.poll(() => polls).toBeGreaterThanOrEqual(1);
    if (scenario === "revoked") {
      await expect(page.getByText("This code no longer works.")).toBeVisible();
    } else {
      await page.clock.runFor(6000);
      if (scenario === "late response") release!();
      await expect(page.getByText("This code expired.")).toBeVisible();
    }
    const count = polls;
    await page.clock.runFor(10000);
    expect(polls).toBe(count);
    await expect(page.getByText(/is signed in\.$/)).toHaveCount(0);
  });
}

test("passkey password errors stay in an accessible form and allow correction", async ({ page }) => {
  await signedIn(page);
  await page.goto("/settings");
  test.skip(!(await page.evaluate(() => typeof window.PublicKeyCredential === "function")));
  const passwords: string[] = [];
  await page.route("**/api/account/passkeys/options", async (route) => {
    passwords.push(route.request().postDataJSON().password);
    await route.fulfill({ status: 403, json: { error: "The current password is incorrect." } });
  });
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a passkey" });
  await dialog.getByLabel("Current password").fill("mistyped-password");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("The current password is incorrect.");
  await expect(dialog.getByLabel("Current password")).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByLabel("Current password")).toHaveValue("");
  const result = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await dialog.getByLabel("Current password").fill("corrected-password");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect.poll(() => passwords).toEqual(["mistyped-password", "corrected-password"]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});
