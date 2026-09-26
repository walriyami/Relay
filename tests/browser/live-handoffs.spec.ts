import { test, expect } from "@playwright/test";
import { BASE, copyShareUrl, destinations, fileInput, signedIn, textFile, unique } from "./helpers";

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test("a share dialog closes and says why once its link is turned off in another tab", async ({ page }) => {
  const name = unique("stale-share");
  await fileInput(page).setInputFiles([textFile(`${name}.txt`)]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await page.getByRole("link", { name: "Files" }).click();
  await page.getByRole("button", { name: `Actions for ${name}.txt` }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Share" }).click();
  const share = page.getByRole("dialog", { name: `${name}.txt` });
  await expect(share.getByRole("button", { name: "Copy link" })).toBeVisible();
  // The card menu's handoff can change and end its link like the others.
  await expect(share.getByRole("button", { name: "Link settings" })).toBeVisible();
  await expect(share.getByRole("button", { name: "Turn off link" })).toBeVisible();

  const other = await page.context().newPage();
  await other.goto("/links");
  await other.getByRole("button", { name: `More actions for ${name}.txt` }).click();
  await other.getByRole("menu").getByRole("menuitem", { name: "Turn off link" }).click();
  await other.getByRole("dialog").getByRole("button", { name: "Turn off link" }).click();
  await expect(other.getByText("Link turned off")).toBeVisible();

  await expect(share).toHaveCount(0);
  await expect(page.getByText("This link was turned off.")).toBeVisible();
  await other.close();
});

test("a request's share dialog closes once the request is closed in another tab", async ({ page }) => {
  const name = unique("stale-request");
  await page.getByRole("link", { name: "Requests" }).click();
  await page.getByRole("button", { name: "New request" }).first().click();
  await page.getByLabel("What are you asking for?").fill(name);
  await page.getByRole("button", { name: "Create request" }).click();
  const share = page.getByRole("dialog", { name });
  await expect(share.getByRole("img", { name: "QR code for this upload request" })).toBeVisible();

  const other = await page.context().newPage();
  await other.goto("/requests");
  await other.getByRole("button", { name: `More actions for ${name}` }).click();
  await other.getByRole("menu").getByRole("menuitem", { name: "Close request" }).click();
  await other.getByRole("dialog").getByRole("button", { name: "Close request" }).click();
  await expect(other.getByText("Request closed")).toBeVisible();

  await expect(share).toHaveCount(0);
  await expect(page.getByText("This request was closed.")).toBeVisible();
  await other.close();
});

test("a sign-in link opened on a signed-in browser explains itself", async ({ page }) => {
  await page.route("**/api/pickup", (route) => route.fulfill({ json: { kind: "device", path: "/?login=234-567" } }));
  await page.goto("/?login=234-567");
  await expect(page.getByRole("heading", { name: "This browser is already signed in as admin" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep using Relay" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Sign out and use the code" })).toBeVisible();
  await page.getByRole("button", { name: "Keep using Relay" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("region", { name: "Compose" })).toBeVisible();
});

test("a dead sign-in code never offers to sign out for it", async ({ page }) => {
  await page.route("**/api/pickup", (route) => route.fulfill({ status: 404, json: { error: "Code unavailable" } }));
  await page.goto("/?login=999-999");
  await expect(page.getByRole("heading", { name: "This sign-in code can’t be used" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep using Relay" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Sign out and use the code" })).toHaveCount(0);
});

for (const handoff of ["code", "link"] as const) {
  test(`a ${handoff} precheck must succeed before offering sign-out and can retry a limit`, async ({ page }) => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => (complete = resolve));
    let attempts = 0;
    const endpoint = handoff === "code" ? "**/api/pickup" : "**/api/session/device-link/test-device-token";
    await page.route(endpoint, async (route) => {
      attempts++;
      if (attempts === 1) {
        await pending;
        await route.fulfill({ status: 429, json: { error: "Too many incorrect codes. Try again in a minute." } });
      } else {
        await route.fulfill({
          json:
            handoff === "code"
              ? { kind: "device", path: "/?device=test-device-token" }
              : { expires: Date.now() + 60_000 },
        });
      }
    });
    await page.goto(handoff === "code" ? "/?login=234-567" : "/?device=test-device-token");
    const signOut = page.getByRole("button", { name: `Sign out and use the ${handoff}` });
    try {
      await expect(page.getByRole("heading", { name: `Checking sign-in ${handoff}` })).toBeVisible();
      await expect(signOut).toHaveCount(0);
    } finally {
      complete();
    }
    await expect(page.getByRole("alert")).toContainText("Too many incorrect codes");
    await expect(signOut).toHaveCount(0);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(signOut).toBeVisible();
    expect(attempts).toBe(2);
  });
}

test("stable device links are checked before asking a signed-in browser to sign out", async ({ page }) => {
  await page.goto("/?device=not-a-real-device-token");
  await expect(page.getByRole("heading", { name: "This sign-in link can’t be used" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out and use the link" })).toHaveCount(0);
  await page.getByRole("button", { name: "Keep using Relay" }).click();
  await page.goto("/settings");
  await page.getByRole("button", { name: "Add a device" }).click();
  const url = await copyShareUrl(page.getByRole("dialog", { name: "Add a device" }), "Copy sign-in link");
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "This browser is already signed in as admin" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out and use the link" })).toBeVisible();
  await page.getByRole("button", { name: "Keep using Relay" }).click();
  await expect(page.getByRole("region", { name: "Compose" })).toBeVisible();
});

test("Back from a sign-in code screen reached inside the app returns to Send", async ({ page }) => {
  await page.route("**/api/pickup", (route) => route.fulfill({ status: 404, json: { error: "Code unavailable" } }));
  await page.evaluate(() => {
    history.pushState(null, "", "/?login=999-999");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { name: "This sign-in code can’t be used" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("region", { name: "Compose" })).toBeVisible();
});

test("closing the first share of an item returns focus to its Share button", async ({ page }) => {
  const name = unique("first-share");
  await fileInput(page).setInputFiles([textFile(`${name}.txt`)]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await page.getByRole("link", { name: "Files" }).click();
  await page
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .press("Enter");
  const popup = page.getByRole("dialog").first();
  const share = popup.getByRole("button", { name: "Share", exact: true });
  await share.press("Enter");
  await expect(page.getByRole("dialog").last().getByRole("button", { name: "Copy link" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(share).toBeFocused();
});

test("Add a device puts focus on Copy sign-in link, and waits out a limit in words", async ({ page }) => {
  let refused = false;
  await page.route("**/api/pickup/current", (route) => route.fulfill({ json: { code: "234-567" } }));
  await page.route("**/api/login-codes", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    if (!refused) {
      refused = true;
      return route.fulfill({
        status: 429,
        headers: { "retry-after": "2" },
        json: { error: "Too many tries. Wait 2 seconds and try again." },
      });
    }
    await route.fulfill({
      json: {
        id: "limit-code",
        code: "234-567",
        token: "fixture-device-token",
        expires: Date.now() + 300_000,
        expiresIn: 300_000,
      },
    });
  });
  await page.route("**/api/login-codes/limit-code/status", (route) => route.fulfill({ json: { state: "pending" } }));
  await page.route("**/api/login-codes/limit-code", (route) => route.fulfill({ json: { ok: true } }));
  await page.getByRole("button", { name: "Add a device" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add a device" });
  await expect(dialog.getByText("Too many new codes in a minute.")).toBeVisible();
  const retry = dialog.getByRole("button", { name: /^Try again in \d s$/ });
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute("aria-disabled", "true");
  await retry.press("Enter");
  await expect(dialog.getByText("Too many new codes in a minute.")).toBeVisible();
  const ready = dialog.getByRole("button", { name: "Try again", exact: true });
  await expect(ready).toBeFocused();
  await ready.press("Enter");
  await expect(dialog.getByRole("button", { name: "Copy sign-in link" })).toBeFocused();
});

test("Enter code keeps focus on its button when a code can't be used here or opens a popup", async ({ page }) => {
  let kind: "device" | "share" = "device";
  await page.route("**/api/pickup", (route) =>
    route.fulfill({
      json: kind === "device" ? { kind, path: "/?login=234-567" } : { kind, path: "/s/not-a-real-token" },
    }),
  );
  const button = page.getByRole("button", { name: "Enter code" });
  await button.press("Enter");
  await expect(page.getByRole("dialog", { name: "Enter a code" }).getByRole("textbox")).toBeFocused();
  await page.keyboard.type("234567");
  await page.keyboard.press("Enter");
  await expect(page.getByText("This browser is already signed in.", { exact: false })).toBeVisible();
  await expect(button).toBeFocused();
  // The full code already submitted; the Enter after it didn't open the popover again.
  await expect(page.getByRole("dialog", { name: "Enter a code" })).toHaveCount(0);
  await page.waitForTimeout(700);

  kind = "share";
  await button.press("Enter");
  await expect(page.getByRole("dialog", { name: "Enter a code" }).getByRole("textbox")).toBeFocused();
  await page.keyboard.type("234567");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Enter a code" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Link unavailable" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("a sign-in code entered at /pickup signs the browser in at once", async ({ page, browser }) => {
  await page.getByRole("button", { name: "Add a device" }).first().click();
  const code = await page
    .getByRole("dialog", { name: "Add a device" })
    .locator(".share-access-code .code")
    .textContent();
  const context = await browser.newContext({ baseURL: BASE });
  try {
    const other = await context.newPage();
    await other.goto("/pickup");
    await expect(other.getByLabel("Pickup code")).toBeFocused();
    await other.keyboard.type(code!);
    await other.keyboard.press("Enter");
    await expect(other.getByRole("region", { name: "Compose" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Add a device" })).toContainText(/signed in/i);
  } finally {
    await context.close();
  }
});
