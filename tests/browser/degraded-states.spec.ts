import { test, expect } from "@playwright/test";
import { signedIn, writeText } from "./helpers";

test("device outages and activity outages remain visible and can be retried", async ({ page }) => {
  // Keep recovery under the Retry controls rather than an initial SSE refresh.
  await page.route("**/api/events?*", (route) => route.abort());
  let fail = true;
  for (const path of ["devices", "activity", "deliveries?direction=incoming"]) {
    await page.route(`**/api/${path.replace("?", "\\?")}`, async (route) => {
      if (!fail) return route.continue();
      await route.fulfill({ status: 503, json: { error: "Temporary review outage" } });
    });
  }
  await signedIn(page);
  await writeText(page, "Device availability check");
  await expect(page.getByText("Device availability is unknown. Retry to refresh.")).toBeVisible();
  await page.getByRole("button", { name: /^Activity/ }).click();
  const panel = page.getByRole("dialog", { name: "Activity", exact: true });
  await expect(panel.getByText(/Temporary review outage/).first()).toBeVisible();
  await expect(panel.getByText("No activity yet")).toHaveCount(0);
  fail = false;
  await panel.getByRole("button", { name: "Retry" }).first().click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Device availability is unknown. Retry to refresh.")).toHaveCount(0);
});

test("requests expire without an SSE event and older closed requests remain reachable", async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  const base = {
    token: "test-token",
    code: "123456",
    description: "",
    created: now,
    maxBytes: 100,
    receivedFiles: 0,
    receivedBytes: 0,
    usedBytes: 0,
    full: false,
    lastReceived: null,
  };
  await page.route("**/api/requests", (route) =>
    route.fulfill({
      json: [
        { ...base, id: "expiring", name: "Expires while open", expires: now + 60_000, closed: false },
        ...Array.from({ length: 101 }, (_, i) => ({
          ...base,
          id: `closed-${i}`,
          name: `Closed request ${i}`,
          expires: now - 1,
          closed: true,
        })),
      ],
    }),
  );
  await signedIn(page);
  await page.getByRole("link", { name: "Requests", exact: true }).click();
  await expect(page.getByRole("list", { name: "Open requests" })).toContainText("Expires while open");
  await page.clock.fastForward(61_000);
  await expect(page.getByRole("list", { name: "Open requests" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Closed requests" })).toContainText("Expires while open");
  await page.getByRole("button", { name: "Show more closed requests" }).click();
  await expect(page.getByRole("list", { name: "Closed requests" })).toContainText("Closed request 100");
});

test("admin health reports cleanup and storage without exposing operator controls", async ({ page }) => {
  await signedIn(page);
  await page.getByRole("button", { name: /^Account/ }).click();
  await page.getByRole("menuitem", { name: "Admin", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Service health" })).toBeVisible();
  await expect(page.getByText("Checks passing", { exact: true })).toBeVisible();
  // A healthy service keeps its detail folded away until asked for.
  await expect(page.getByText(/maintenance jobs are running on schedule/)).toBeVisible();
  await expect(page.getByText("Library retention", { exact: true })).toBeHidden();
  await page.getByText("Details", { exact: true }).click();
  await expect(page.getByText("Library retention", { exact: true })).toBeVisible();
  await expect(page.getByText(/unique · .* in \d+ trashed items?/)).toBeVisible();
  await expect(page.getByRole("button", { name: /backup|restore snapshot/i })).toHaveCount(0);
});

test("an unavailable handoff stops offering its QR and copy actions", async ({ page }) => {
  await page.route("**/api/pickup/current", (route) => route.fulfill({ json: { code: null } }));
  await signedIn(page);
  await page.getByRole("link", { name: "Requests", exact: true }).click();
  await page.getByRole("button", { name: "New request" }).first().click();
  await page.getByLabel("What are you asking for?").fill("Unavailable handoff fixture");
  await page.getByRole("button", { name: "Create request" }).click();
  const dialog = page.getByRole("dialog", { name: "Unavailable handoff fixture" });
  await expect(dialog.getByRole("status").filter({ hasText: "This handoff is no longer available" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy link" })).toHaveCount(0);
  await expect(dialog.getByRole("img", { name: /QR code/ })).toHaveCount(0);
});
