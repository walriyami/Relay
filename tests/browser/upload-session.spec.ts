import { test, expect } from "@playwright/test";
import { signedIn, fileInput, textFile, unique, destinations } from "./helpers";

for (const status of [401, 404]) {
  test(`upload ${status} recognizes a lapsed session`, async ({ page }) => {
    // Hold the independent account stream: its quota refreshes are not upload-error diagnostics.
    // The page context closes this pending request when the test ends.
    await page.route("**/api/events?*", () => {});
    await signedIn(page);
    let probes = 0;
    // Picking refreshes the session to re-check free space; the session only lapses once sending starts.
    let armed = false;
    await page.route("**/api/session", async (route) => {
      if (route.request().method() !== "GET" || !armed) return route.continue();
      probes++;
      await route.fulfill({ status: 401, json: { error: "Sign in to continue." } });
    });
    await page.route("**/uploads/**", async (route) => {
      await route.fulfill({ status, json: { error: "Upload unavailable." } });
    });
    const quota = page.waitForResponse("**/api/session");
    await fileInput(page).setInputFiles(textFile(unique("expired") + ".txt"));
    expect((await quota).ok()).toBe(true);
    const save = destinations(page).getByRole("button", { name: "Save to Files" });
    await expect(save).toBeEnabled();
    armed = true;
    await save.click();
    await expect(page.getByText("Your session ended. Sign in again to continue.")).toBeVisible();
    expect(probes).toBe(status === 404 ? 1 : 0);
    await expect(page.locator(".transfer")).toHaveCount(0);
  });
}

test("a missing upload with a valid session stays a file error", async ({ page }) => {
  // Keep live account refreshes separate from the one diagnostic shared by all failed files.
  await page.route("**/api/events?*", () => {});
  await signedIn(page);
  let probes = 0;
  let armed = false;
  await page.route("**/api/session", async (route) => {
    if (route.request().method() === "GET" && armed) probes++;
    await route.continue();
  });
  await page.route("**/uploads/**", async (route) => {
    await route.fulfill({ status: 404, json: { error: "This upload no longer exists." } });
  });
  const quota = page.waitForResponse("**/api/session");
  await fileInput(page).setInputFiles([1, 2, 3].map((n) => textFile(`${unique("missing")}-${n}.txt`)));
  expect((await quota).ok()).toBe(true);
  const save = destinations(page).getByRole("button", { name: "Save to Files" });
  await expect(save).toBeEnabled();
  armed = true;
  await save.click();
  await expect(page.locator(".transfer")).toContainText("3 files couldn’t upload");
  expect(probes).toBe(1);
  await page.locator(".transfer").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".transfer")).toContainText("Cancelled");
});

test("a closed guest stream reconnects while its upload remains active", async ({ page, browser }) => {
  await signedIn(page);
  const session = await (await page.request.get("/api/session")).json();
  const response = await page.request.post("/api/requests", {
    headers: { "X-Relay-CSRF": session.csrf },
    data: { id: crypto.randomUUID(), name: unique("guest-reconnect"), days: 1, maxBytes: 1024 * 1024 },
  });
  expect(response.ok()).toBe(true);
  const request = await response.json();
  const visitor = await browser.newContext();
  const guest = await visitor.newPage();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ids: string[] = [];
  await guest.route("**/api/r/*/events?*", async (route) => {
    ids.push(new URL(route.request().url()).searchParams.get("tab")!);
    if (ids.length === 1) return route.fulfill({ status: 204 });
    return route.continue();
  });
  await guest.route("**/uploads/**", async (route) => {
    if (route.request().method() === "PATCH") await held;
    return route.continue();
  });
  try {
    await guest.goto(new URL(`/r/${request.token}`, page.url()).href);
    await guest.getByTestId("guest-file-input").setInputFiles(textFile("guest-stream.txt"));
    await guest.getByRole("button", { name: "Upload 1 file", exact: true }).click();
    await expect.poll(() => ids.length).toBe(2);
    expect(new Set(ids).size).toBe(1);
    release();
    await expect(guest.getByRole("heading", { name: "Files sent" })).toBeVisible();
  } finally {
    release();
    await visitor.close();
  }
});
