import { test as base, expect, request, type Page } from "@playwright/test";
import { api } from "../../shared/api";
import {
  BASE,
  destinations,
  deviceContext,
  deviceState,
  fileInput,
  signedIn,
  textFile,
  unique,
  writeText,
} from "./helpers";

const test = base.extend<{ settingsPage: Page }>({
  settingsPage: async ({ page }, use) => {
    // Settings belong to the account, so every settings test gets its own member. A failed or
    // delayed save can never change the shared administrator's defaults for another test.
    const admin = await request.newContext({ baseURL: BASE, storageState: await deviceState("Laptop") });
    const before = await (await admin.get(api.session.get.path)).json();
    try {
      const invite = await admin.post(api.admin.invite.path, { headers: { "X-Relay-CSRF": before.csrf } });
      expect(invite.ok()).toBe(true);
      const { token } = await invite.json();
      const joined = await page.request.post(api.session.join.path, {
        data: { token, username: unique("settings").toLowerCase(), password: "Browser-test-password-only" },
      });
      expect(joined.ok()).toBe(true);
      await page.goto("/settings");
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await use(page);
    } finally {
      try {
        const after = await (await admin.get(api.session.get.path)).json();
        expect(after.prefs, "settings tests must preserve the shared account's preferences").toEqual(before.prefs);
        expect(after.user.retentionDays, "settings tests must preserve the shared account's retention").toBe(
          before.user.retentionDays,
        );
      } finally {
        await admin.dispose();
      }
    }
  },
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

async function createRequest(page: Page, name: string) {
  await signedIn(page);
  const session = await (await page.request.get("/api/session")).json();
  const response = await page.request.post("/api/requests", {
    headers: { "X-Relay-CSRF": session.csrf },
    data: { id: crypto.randomUUID(), name, days: 7, maxBytes: 1024 ** 3 },
  });
  expect(response.ok()).toBe(true);
  return { request: (await response.json()) as { id: string; token: string }, csrf: session.csrf as string };
}

test("a guest can retry a request after an initial network failure", async ({ page, browser }) => {
  const name = unique("guest-retry");
  const { request } = await createRequest(page, name);
  const context = await browser.newContext({ baseURL: BASE });
  try {
    const guest = await context.newPage();
    await guest.route(`**/api/r/${request.token}`, (route) =>
      route.fulfill({ status: 503, json: { error: "The request could not be reached." } }),
    );
    await guest.goto(`/r/${request.token}`);
    await expect(guest.getByRole("heading", { name: "Request unavailable" })).toBeVisible();
    await guest.unroute(`**/api/r/${request.token}`);
    await guest.getByRole("button", { name: "Try again" }).click();
    await expect(guest.getByRole("heading", { name })).toBeVisible();
    await expect(guest.getByRole("button", { name: "Add files" })).toBeEnabled();
  } finally {
    await context.close();
  }
});

test("an existing guest page keeps its draft after a failed refresh and reloads current details", async ({
  page,
  browser,
}) => {
  const name = unique("guest-recovery");
  const { request, csrf } = await createRequest(page, name);
  const context = await browser.newContext({ baseURL: BASE });
  try {
    const guest = await context.newPage();
    await guest.goto(`/r/${request.token}`);
    const filename = `${name}.txt`;
    await guest.getByTestId("guest-file-input").setInputFiles(textFile(filename));
    await guest.getByLabel("Your name (optional)").fill("Guest sender");
    // A temporary service failure must not discard this already-open guest page's draft.
    await guest.route(`**/api/r/${request.token}`, (route) =>
      route.fulfill({ status: 503, json: { error: "The request could not be reached." } }),
    );
    const failedRefresh = guest.waitForResponse(
      (response) => response.url().endsWith(`/api/r/${request.token}`) && response.status() === 503,
    );
    await guest.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await (await failedRefresh).finished();
    // A failed background refresh keeps the last loaded details and the editable draft visible.
    await expect(guest.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(guest.getByRole("heading", { name: "Request unavailable" })).toHaveCount(0);
    await expect(guest.getByText(filename, { exact: true })).toBeVisible();
    await expect(guest.getByLabel("Your name (optional)")).toHaveValue("Guest sender");
    await expect(guest.getByRole("button", { name: /^Upload/ })).toBeEnabled();
    const response = await page.request.patch(`/api/requests/${request.id}`, {
      headers: { "X-Relay-CSRF": csrf },
      data: { name: `${name} updated`, description: "", days: 30, maxBytes: 1024 ** 3 },
    });
    expect(response.ok()).toBe(true);
    await guest.unroute(`**/api/r/${request.token}`);
    await guest.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(guest.getByRole("heading", { name: `${name} updated` })).toBeVisible();
    await expect(guest.getByText(filename, { exact: true })).toBeVisible();
    await expect(guest.getByLabel("Your name (optional)")).toHaveValue("Guest sender");
    await expect(guest.getByRole("button", { name: /^Upload/ })).toBeEnabled();
  } finally {
    await context.close();
  }
});

const expiry = (page: Page) => page.getByRole("radiogroup", { name: "Links expire after" });

test("queued settings preserve latest choices and ignore an older session response", async ({ settingsPage: page }) => {
  const firstWrite = gate();
  const releaseWrite = gate();
  const oldSession = gate();
  const releaseSession = gate();
  const sessionDone = gate();
  let writes = 0;
  let sessions = 0;
  await page.route("**/api/session", async (route) => {
    if (++sessions !== 1) return route.continue();
    const response = await route.fetch();
    expect((await response.json()).prefs.linkDays).toBe(1);
    oldSession.open();
    await releaseSession.promise;
    await route.fulfill({ response });
    sessionDone.open();
  });
  await page.route("**/api/account", async (route) => {
    if (++writes !== 1) return route.continue();
    const response = await route.fetch();
    firstWrite.open();
    await releaseWrite.promise;
    await route.fulfill({ response });
  });
  try {
    await expiry(page).getByRole("radio", { name: "1 day", exact: true }).click();
    await firstWrite.promise;
    await oldSession.promise;
    await expiry(page).getByRole("radio", { name: "30 days", exact: true }).click();
    await page.getByRole("switch", { name: "Sign-ins and security" }).click();
    await expect(expiry(page).getByRole("radio", { name: "30 days" })).toHaveAttribute("aria-checked", "true");
    expect(writes).toBe(1);
    releaseWrite.open();
    await expect
      .poll(async () => {
        const saved = await (await page.request.get("/api/session")).json();
        return [saved.prefs.linkDays, saved.prefs.activity.security];
      })
      .toEqual([30, false]);
    await expect(page.getByRole("switch", { name: "Sign-ins and security" })).not.toBeChecked();
    releaseSession.open();
    await sessionDone.promise;
    await expect(expiry(page).getByRole("radio", { name: "30 days" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("link", { name: "Send", exact: true }).click();
    await writeText(page, "Use the latest saved setting");
    await expect(destinations(page).getByRole("button", { name: "Create link" })).toHaveAccessibleDescription(
      "Expires in 30 days",
    );
  } finally {
    releaseWrite.open();
    releaseSession.open();
  }
});

test("a failed setting is recovered before later queued choices save", async ({ settingsPage: page }) => {
  const firstWrite = gate();
  const releaseWrite = gate();
  let writes = 0;
  await page.route("**/api/account", async (route) => {
    if (++writes !== 1) return route.continue();
    firstWrite.open();
    await releaseWrite.promise;
    await route.fulfill({ status: 503, json: { error: "Could not save the first choice." } });
  });
  try {
    await expiry(page).getByRole("radio", { name: "1 day", exact: true }).click();
    await firstWrite.promise;
    await page
      .getByRole("radiogroup", { name: "Move uploads to Trash after" })
      .getByRole("radio", { name: "30 days" })
      .click();
    await page.getByRole("switch", { name: "Sign-ins and security" }).click();
    expect(writes).toBe(1);
    releaseWrite.open();
    await expect(page.getByText("Could not save the first choice.")).toBeVisible();
    await expect
      .poll(async () => {
        const saved = await (await page.request.get("/api/session")).json();
        return [saved.prefs.linkDays, saved.user.retentionDays, saved.prefs.activity.security];
      })
      .toEqual([7, 30, false]);
    await expect(expiry(page).getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("switch", { name: "Sign-ins and security" })).not.toBeChecked();
    await page.getByRole("link", { name: "Send", exact: true }).click();
    // Fix the absolute deadline so the composer proves the failed one-day choice was rolled back.
    const now = Date.now();
    await page.clock.setFixedTime(now);
    await writeText(page, "Use the last saved setting after failure");
    const deadline = await page.evaluate(
      (timestamp) =>
        new Date(timestamp).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
      now + 7 * 86_400_000,
    );
    await expect(destinations(page).getByRole("button", { name: "Create link" })).toHaveAccessibleDescription(
      `Expires by ${deadline}`,
    );
  } finally {
    releaseWrite.open();
  }
});

test("two manual accepts download once, and a later explicit Download still works", async ({ page, browser }) => {
  await signedIn(page, "Laptop");
  const receiver = await deviceContext(browser, unique("Claim receiver"));
  const releaseAnswers = gate();
  try {
    await receiver.page.getByRole("button", { name: /^Account:/ }).click();
    await receiver.page.getByRole("menuitemcheckbox", { name: "Auto-accept" }).click();
    await receiver.page.keyboard.press("Escape");
    const second = await receiver.context.newPage();
    await second.goto("/");
    const filename = `${unique("manual-claim")}.txt`;
    await fileInput(page).setInputFiles(textFile(filename));
    await destinations(page).getByRole("button", { name: receiver.name, exact: true }).click();
    const popups = [receiver.page, second].map((tab) => tab.getByRole("dialog", { name: filename }));
    for (const [index, tab] of [receiver.page, second].entries()) {
      await tab.bringToFront();
      await expect(popups[index].getByRole("button", { name: "Accept and download" })).toBeVisible();
    }
    const bothAnswers = gate();
    let answers = 0;
    await receiver.context.route("**/api/deliveries/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      if (++answers === 2) bothAnswers.open();
      await releaseAnswers.promise;
      await route.continue();
    });
    const downloads: string[] = [];
    for (const tab of [receiver.page, second])
      tab.on("download", (download) => downloads.push(download.suggestedFilename()));
    await popups[0].getByRole("button", { name: "Accept and download" }).click();
    await popups[1].getByRole("button", { name: "Accept and download" }).click();
    await bothAnswers.promise;
    releaseAnswers.open();
    for (const popup of popups)
      await expect(popup.getByRole("button", { name: "Download", exact: true })).toBeEnabled();
    await expect.poll(() => downloads).toEqual([filename]);
    const again = second.waitForEvent("download");
    await popups[1].getByRole("button", { name: "Download", exact: true }).click();
    expect((await again).suggestedFilename()).toBe(filename);
    expect(downloads).toEqual([filename, filename]);
  } finally {
    releaseAnswers.open();
    await receiver.context.close();
  }
});
