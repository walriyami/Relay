import { expect, test, type Page } from "@playwright/test";
import { BASE, composer, selected, signedIn } from "./helpers";

// Relay as an installed app: its service worker, "Share to Relay", and push notifications. Other
// specs block service workers (playwright.config.ts); these need Relay's own. Chromium only: its
// DevTools protocol can deliver a push message without a push service.
// The full Chromium, not Playwright's headless shell, which reports notifications as blocked.
test.use({ serviceWorkers: "allow", channel: "chromium" });
test.beforeEach(() => {
  test.skip(test.info().project.name !== "chromium", "Service worker checks run in desktop Chromium");
});

/** Opens Relay and waits until its service worker controls the page. */
async function controlled(page: Page) {
  await signedIn(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

/** Posts a share as the phone's share sheet does: a form submission to /share. */
async function shareSheet(page: Page, share: { title?: string; text?: string; url?: string; file?: string }) {
  await page.evaluate((share) => {
    const form = document.createElement("form");
    form.method = "post";
    form.enctype = "multipart/form-data";
    form.action = "/share";
    for (const name of ["title", "text", "url"] as const) {
      const value = share[name];
      if (!value) continue;
      const input = document.createElement("input");
      input.name = name;
      input.value = value;
      form.append(input);
    }
    if (share.file) {
      const input = document.createElement("input");
      input.type = "file";
      input.name = "files";
      const files = new DataTransfer();
      files.items.add(new File([`contents of ${share.file}`], share.file, { type: "text/plain" }));
      input.files = files.files;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  }, share);
}

test("Relay can be installed, and its worker keeps only the app itself", async ({ page }) => {
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  const app = (await manifest.json()) as { display: string; share_target: { action: string }; icons: unknown[] };
  expect(app.display).toBe("standalone");
  expect(app.share_target.action).toBe("/share");
  expect(app.icons.length).toBeGreaterThanOrEqual(3);

  await controlled(page);
  // Something private passes through: the account, and a list of files.
  await page.evaluate(() => fetch("/api/session").then((r) => r.text()));
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
    return urls;
  });
  expect(cached).toContain("/");
  expect(cached.some((path) => path.startsWith("/assets/"))).toBe(true);
  expect(cached.filter((path) => /^\/(api|uploads|local)\//.test(path))).toEqual([]);
});

const arrived = (page: Page) => page.getByRole("heading", { name: "Something was shared to Relay" });

test("Share to Relay shows what arrived, and one tap adds it to the Send draft", async ({ page }) => {
  await controlled(page);
  await shareSheet(page, { file: "shared.txt", text: "From the share sheet" });
  await expect(arrived(page)).toBeVisible();
  await expect(page.getByRole("list", { name: "Shared files" })).toContainText("shared.txt");
  await expect(page.getByRole("group", { name: "Shared text" })).toContainText("From the share sheet");
  await expect(page.getByRole("button", { name: "Add to Send" })).toBeFocused();
  await page.getByRole("button", { name: "Add to Send" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(selected(page)).toContainText("shared.txt");
  await expect(page.getByText("1 file added. Choose where it goes.")).toBeVisible();

  // A link from a browser's share sheet arrives as text.
  await shareSheet(page, { title: "Relay docs", url: "https://example.com/docs" });
  await expect(page.getByRole("group", { name: "Shared text" })).toContainText("https://example.com/docs");
  await page.getByRole("button", { name: "Add to Send" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(composer(page).getByRole("textbox")).toHaveValue(/Relay docs\nhttps:\/\/example\.com\/docs/);
});

test("nothing shared to Relay reaches the draft until Add, and Discard forgets it", async ({ page }) => {
  // A website can post the same form as the share sheet, so arrival alone must not fill the draft.
  await controlled(page);
  await shareSheet(page, { text: "Planted by a website" });
  await expect(arrived(page)).toBeVisible();
  const shared = page.url();
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  await expect(composer(page).locator("textarea")).toHaveValue("");

  // Still waiting until it's added or discarded.
  await page.goto(shared);
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(page.getByText("Discarded. Nothing was added.")).toBeVisible();
  await expect(composer(page).locator("textarea")).toHaveValue("");
  // Gone for good: the same address now goes straight to Send.
  await page.goto(shared);
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(composer(page).locator("textarea")).toHaveValue("");
});

test("the iPhone Shortcut's address offers its text without sending it to the server", async ({ page }) => {
  await signedIn(page);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/share#text=" + encodeURIComponent("Note from Shortcuts"));
  await expect(page.getByRole("group", { name: "Shared text" })).toContainText("Note from Shortcuts");
  await expect(composer(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Add to Send" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(composer(page).getByRole("textbox")).toHaveValue(/Note from Shortcuts/);
  expect(requests.some((url) => url.includes("Note"))).toBe(false);
});

test("a push message shows a notification when no Relay window is in front", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  await controlled(page);
  const cdp = await context.newCDPSession(page);
  const registration = new Promise<string>((resolve) =>
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      const ours = registrations.find((r) => r.scopeURL === `${BASE}/` && !r.isDeleted);
      if (ours) resolve(ours.registrationId);
    }),
  );
  await cdp.send("ServiceWorker.enable");
  const registrationId = await registration;
  // Headless Chromium shows notifications without keeping them listed, so the worker's calls are watched.
  const [worker] = context.serviceWorkers();
  await worker.evaluate(() => {
    const shown: unknown[] = [];
    Object.assign(self, { shown });
    const registration = (self as unknown as { registration: ServiceWorkerRegistration }).registration;
    const show = registration.showNotification.bind(registration);
    registration.showNotification = (title, options) => {
      shown.push({ title, body: options?.body, url: (options?.data as { url?: string } | undefined)?.url });
      return show(title, options);
    };
  });
  // With Relay in front, the page shows news itself; with no Relay window, a notification does.
  await page.goto("about:blank");
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin: BASE,
    registrationId,
    data: JSON.stringify({
      title: "From Phone",
      body: "“Beach” is waiting on this device.",
      url: "/",
      tag: "delivery:1",
    }),
  });
  await expect
    .poll(() => worker.evaluate(() => (self as unknown as { shown: unknown[] }).shown))
    .toEqual([{ title: "From Phone", body: "“Beach” is waiting on this device.", url: "/" }]);
});

test("notifications are offered in Settings, and once in the bell", async ({ page }) => {
  await controlled(page);
  await page.goto("/settings#s-notify");
  const toggle = page.getByRole("switch", { name: "Notifications on this device" });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(page.getByText("When something arrives for this device", { exact: false })).toBeVisible();

  const bell = page.getByRole("button", { name: /^Activity/ });
  await bell.click();
  const offer = page.getByText("Get notified on this device");
  await expect(offer).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(offer).toHaveCount(0);
  await page.reload();
  await bell.click();
  await expect(page.getByRole("dialog", { name: "Activity" })).toBeVisible();
  await expect(offer).toHaveCount(0);
});
