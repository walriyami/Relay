import { expect, request, test } from "@playwright/test";
import { api } from "../../shared/api.ts";
import {
  copyShareUrl,
  BASE,
  composer,
  destinations,
  deviceContext,
  deviceState,
  fileInput,
  textFile,
  unique,
} from "./helpers";

test("a closed member stream retries with the same transfer lease id", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE, storageState: await deviceState("Laptop") });
  const page = await context.newPage();
  const ids: string[] = [];
  await context.route("**/api/events?*", async (route) => {
    ids.push(new URL(route.request().url()).searchParams.get("tab") || "");
    await route.fulfill({ status: 204 });
  });

  try {
    await page.goto("/");
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => ids.length, { timeout: 8000 }).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(1);
  } finally {
    await context.close();
  }
});

test("the next load closes the old tab marker and a persisted pageshow reloads", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE, storageState: await deviceState("Laptop") });
  const page = await context.newPage();
  const oldTab = "01234567abcdef01234567abcdef";
  const closeRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(`/api/tabs/${oldTab}/close`))
      closeRequests.push(request.url());
  });
  await page.addInitScript((tab) => {
    if (!sessionStorage.getItem("relay-live-test-seeded")) {
      sessionStorage.setItem("relay.open-tab", JSON.stringify({ tab, csrf: "" }));
      sessionStorage.setItem("relay-live-test-seeded", "yes");
    }
    const loads = Number(sessionStorage.getItem("relay-live-test-loads") || "0") + 1;
    sessionStorage.setItem("relay-live-test-loads", String(loads));
  }, oldTab);

  try {
    await page.goto("/");
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => closeRequests.length).toBe(1);

    const nextLoad = page.waitForEvent("load");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await nextLoad;
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("relay-live-test-loads"))).toBe("2");
    expect(closeRequests).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("signing into another member in the same tab gets a new lease for its next upload", async ({ browser }) => {
  // Its own client address (the test server trusts the local proxy header), so sign-ins by earlier
  // specs never put this one over the real per-address sign-in limit.
  const context = await browser.newContext({
    baseURL: BASE,
    storageState: await deviceState("Account switch"),
    extraHTTPHeaders: { "X-Forwarded-For": "198.51.100.58" },
  });
  const page = await context.newPage();
  const streamTabs: string[] = [];
  const createTabs: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname === "/api/events") streamTabs.push(url.searchParams.get("tab") || "");
    if (req.method() === "POST" && url.pathname === api.transfers.create.path)
      createTabs.push((req.postDataJSON() as { tab: string }).tab);
  });

  try {
    await page.goto("/");
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => streamTabs.length).toBeGreaterThan(0);
    const adminTab = streamTabs.at(-1)!;

    await page.getByRole("button", { name: "Account: admin" }).click();
    await page.getByRole("menuitem", { name: "Admin" }).click();
    await page.getByRole("button", { name: "Invite member" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
    const inviteUrl = await copyShareUrl(page.getByRole("dialog"));
    const token = new URL(inviteUrl).pathname.split("/").at(-1)!;
    const username = unique("switch").toLowerCase();
    const joinContext = await request.newContext({ baseURL: BASE });
    try {
      const joined = await joinContext.post(api.session.join.path, {
        data: { token, username, password: "Browser-test-password-only", deviceName: "Member device" },
      });
      expect(joined.ok()).toBe(true);
    } finally {
      await joinContext.dispose();
    }

    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Account: admin" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill("Browser-test-password-only");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => new Set(streamTabs).size).toBeGreaterThan(1);
    const memberTab = streamTabs.at(-1)!;
    expect(memberTab).not.toBe(adminTab);

    const name = unique("member-upload");
    await fileInput(page).setInputFiles([textFile(`${name}.txt`, "saved under the new member")]);
    await destinations(page).getByRole("button", { name: "Save to Files" }).click();
    await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
    expect(createTabs).toHaveLength(1);
    expect(createTabs[0]).toBe(memberTab);
  } finally {
    await context.close();
  }
});

test("duplicating an active tab does not copy an abandonment marker", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE, storageState: await deviceState("Laptop") });
  const original = await context.newPage();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let uploading!: () => void;
  const started = new Promise<void>((resolve) => {
    uploading = resolve;
  });
  await original.route("**/uploads/**", async (route) => {
    if (route.request().method() === "PATCH") {
      uploading();
      await held;
    }
    await route.continue();
  });
  try {
    await original.goto("/");
    await expect(composer(original)).toBeVisible();
    await fileInput(original).setInputFiles(textFile(unique("original-lease") + ".txt"));
    await destinations(original).getByRole("button", { name: "Save to Files" }).click();
    await started;
    const storage = await original.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
    expect(storage["relay.open-tab"]).toBeUndefined();
    const duplicate = await context.newPage();
    await duplicate.addInitScript((values) => {
      for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value);
    }, storage);
    const closes: string[] = [];
    duplicate.on("request", (req) => {
      if (req.method() === "POST" && /\/api\/tabs\/[^/]+\/close$/.test(new URL(req.url()).pathname))
        closes.push(req.url());
    });
    await duplicate.goto("/");
    await expect(composer(duplicate)).toBeVisible();
    expect(closes).toEqual([]);
    release();
    await expect(original.locator(".transfer")).toContainText("Saved to Files");
  } finally {
    release();
    await context.close();
  }
});

test("Files to Trash does not flash cards from the previous query", async ({ browser }) => {
  const { context, page } = await deviceContext(browser, "Laptop");
  const name = unique("stale-query");
  let releaseTrash!: () => void;
  const trashResponse = new Promise<void>((resolve) => {
    releaseTrash = resolve;
  });
  let trashRequested = false;
  await page.route("**/api/items?*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.get("view") === "trash") {
      trashRequested = true;
      await trashResponse;
    }
    await route.continue();
  });

  try {
    await fileInput(page).setInputFiles([textFile(`${name}.txt`, "library item")]);
    await destinations(page).getByRole("button", { name: "Save to Files" }).click();
    await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
    await page.getByRole("link", { name: "Files" }).click();
    const files = page.getByRole("list", { name: "Files" });
    await expect(files.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();

    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
    await expect.poll(() => trashRequested).toBe(true);
    const trash = page.getByRole("list", { name: "Trash" });
    await expect(trash.locator('[role="listitem"]').filter({ hasText: name })).toHaveCount(0);
    await expect(trash).toHaveCount(0);
    releaseTrash();
    await expect(trash.locator('[role="listitem"]').filter({ hasText: name })).toHaveCount(0);
  } finally {
    releaseTrash();
    await context.close();
  }
});
