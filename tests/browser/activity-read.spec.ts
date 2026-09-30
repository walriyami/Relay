import { test, expect, type Page } from "@playwright/test";
import type { ActivityEntry, Delivery } from "../../shared/model";
import { BASE, signedIn, textFile, unique } from "./helpers";

const events = (count: number, at = Date.now() - 1000): Extract<ActivityEntry, { kind: "upload" }>[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `event-${String(count - i).padStart(3, "0")}`,
    created: at - i,
    self: false,
    kind: "upload",
    requestId: "fixture-request",
    request: `Documents ${i}`,
    sender: "Fixture sender",
    itemId: "fixture-item",
    files: 1,
    bytes: 12,
    text: false,
  }));

async function fixture(page: Page, entries: ActivityEntry[], deliveries: Delivery[] = []) {
  let seen = 0;
  const writes: number[] = [];
  await page.route("**/api/activity", (route) => route.fulfill({ json: { entries, seen } }));
  await page.route("**/api/activity/seen", async (route) => {
    seen = route.request().postDataJSON().until;
    writes.push(seen);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/deliveries?*", (route) => route.fulfill({ json: deliveries }));
  await signedIn(page);
  await page.getByRole("button", { name: /^Activity/ }).click();
  return { panel: page.getByRole("dialog", { name: "Activity", exact: true }), writes };
}

for (const count of [60, 100]) {
  test(`${count} account events remain reachable without acknowledging them on open`, async ({ page }, testInfo) => {
    const entries = events(count);
    const { panel, writes } = await fixture(page, entries);
    await expect(panel.getByRole("region", { name: "Recent activity" }).getByRole("listitem")).toHaveCount(count);
    await panel.getByRole("button", { name: new RegExp(`Documents ${count - 1}”`) }).scrollIntoViewIfNeeded();
    await expect(panel.getByText(new RegExp(`Documents ${count - 1}”`))).toBeVisible();
    expect(writes).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("activity-unread.png"), animations: "disabled" });
    const mark = panel.getByRole("button", { name: "Mark all as read", exact: true });
    await mark.press("Enter");
    await expect.poll(() => writes).toEqual([entries[0].created]);
    await expect(panel.locator(".is-fresh")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Activity", exact: true })).toBeVisible();
  });
}

test("interleaved delivery history has an explicit 100-event boundary and opening never marks hidden events", async ({
  page,
}) => {
  const entries = events(100);
  const deliveries: Delivery[] = Array.from({ length: 20 }, (_, i) => ({
    id: `delivery-${i}`,
    itemId: "fixture-item",
    state: "accepted",
    created: entries[0].created - i * 4,
    answered: entries[0].created - i * 4,
    from: { id: "sender", name: "Other device" },
    to: null,
    available: true,
    item: null,
  }));
  const { panel, writes } = await fixture(page, entries, deliveries);
  await expect(panel.getByRole("region", { name: "Recent activity" }).getByRole("listitem")).toHaveCount(100);
  await expect(panel.getByText("Showing the latest 100 events.", { exact: true })).toBeVisible();
  await expect(panel.getByText(/from Other device/)).toHaveCount(20);
  await expect(panel.getByText(/Documents 99”/)).toHaveCount(0);
  const rows = await panel.getByRole("listitem").allTextContents();
  expect(rows[0]).toContain("Documents 0");
  expect(rows[1]).toContain("Other device");
  expect(rows.at(-1)).toContain("Documents 79");
  expect(writes).toEqual([]);
  await panel.getByRole("button", { name: "Mark all as read" }).click();
  await expect.poll(() => writes).toEqual([entries[0].created]);
  await expect(panel.locator(".is-fresh")).toHaveCount(0);
});

test("new arrivals and tied timestamps stay unread until an explicit acknowledgement; failed marking can retry", async ({
  page,
}) => {
  const entries = events(2);
  entries[1].created = entries[0].created;
  let seen = 0;
  const writes: number[] = [];
  let refuse = true;
  await page.route("**/api/activity", (route) => route.fulfill({ json: { entries, seen } }));
  await page.route("**/api/activity/seen", async (route) => {
    writes.push(route.request().postDataJSON().until);
    if (refuse) return route.fulfill({ status: 503, json: { error: "Could not mark activity as read." } });
    seen = writes.at(-1)!;
    await route.fulfill({ json: { ok: true } });
  });
  await signedIn(page);
  await page.getByRole("button", { name: /^Activity/ }).click();
  const panel = page.getByRole("dialog", { name: "Activity", exact: true });
  await expect(panel.locator(".is-fresh")).toHaveCount(2);
  const initial = await panel.getByRole("listitem").allTextContents();
  expect(initial[0]).toContain("Documents 0");
  expect(initial[1]).toContain("Documents 1");
  entries.unshift({ ...events(1, entries[0].created + 1)[0], id: "arrived", request: "New arrival" });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(panel.locator(".is-fresh")).toHaveCount(3);
  expect(writes).toEqual([]);
  await panel.getByRole("button", { name: "Mark all as read" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not mark activity as read." })).toBeVisible();
  await expect(panel.locator(".is-fresh")).toHaveCount(3);
  refuse = false;
  await panel.getByRole("button", { name: "Mark all as read" }).click();
  await expect(panel.locator(".is-fresh")).toHaveCount(0);
  expect(writes).toEqual([entries[0].created, entries[0].created]);
});

test("an arrival newer than an in-flight acknowledgement remains unread", async ({ page }) => {
  const entries = events(1);
  const until = entries[0].created;
  let seen = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let written = 0;
  await page.route("**/api/activity", (route) => route.fulfill({ json: { entries, seen } }));
  await page.route("**/api/activity/seen", async (route) => {
    written = route.request().postDataJSON().until;
    await held;
    seen = written;
    await route.fulfill({ json: { ok: true } });
  });
  await signedIn(page);
  await page.getByRole("button", { name: /^Activity/ }).click();
  const panel = page.getByRole("dialog", { name: "Activity", exact: true });
  try {
    await panel.getByRole("button", { name: "Mark all as read" }).click();
    await expect.poll(() => written).toBe(until);
    entries.unshift({ ...events(1, until + 1)[0], id: "newer", request: "Arrived during marking" });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(panel.locator(".is-fresh")).toHaveCount(2);
    release();
    await expect(panel.locator(".is-fresh")).toHaveCount(1);
    await expect(panel.locator(".is-fresh")).toContainText("Arrived during marking");
  } finally {
    release();
  }
});

test("explicit read state reaches another device, while a later real request upload stays unread", async ({
  page,
  browser,
}) => {
  await signedIn(page, unique("Read owner"));
  const other = await browser.newContext({ baseURL: BASE });
  const phone = await other.newPage();
  const guest = await browser.newContext({ baseURL: BASE });
  try {
    await signedIn(phone, unique("Read phone"));
    const session = await (await page.request.get("/api/session")).json();
    const created = await page.request.post("/api/requests", {
      headers: { "X-Relay-CSRF": session.csrf },
      data: { id: crypto.randomUUID(), name: unique("Read documents"), description: "", days: 1, maxBytes: 1000 },
    });
    expect(created.ok()).toBe(true);
    const request = await created.json();
    await page.getByRole("button", { name: /^Activity/ }).click();
    await phone.getByRole("button", { name: /^Activity/ }).click();
    const panel = page.getByRole("dialog", { name: "Activity", exact: true });
    const phonePanel = phone.getByRole("dialog", { name: "Activity", exact: true });
    await panel.getByRole("button", { name: "Mark all as read" }).click();
    await expect(phonePanel.locator(".is-fresh")).toHaveCount(0);
    const before = (await (await phone.request.get("/api/activity")).json()).seen;
    expect(before).toBeGreaterThan(0);
    const visitor = await guest.newPage();
    await visitor.goto(`/r/${request.token}`);
    await visitor.getByTestId("guest-file-input").setInputFiles(textFile("Read fixture.txt", "ordinary upload"));
    await visitor.getByRole("button", { name: "Upload 1 file", exact: true }).click();
    await expect(visitor.locator(".guest-sent")).toBeVisible();
    await expect(panel.locator(".is-fresh")).toHaveCount(1);
    await expect(phonePanel.locator(".is-fresh")).toHaveCount(1);
    expect((await (await phone.request.get("/api/activity")).json()).seen).toBe(before);
  } finally {
    await other.close();
    await guest.close();
  }
});
