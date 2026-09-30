import { test, expect, type Page } from "@playwright/test";
import type { Link } from "../../shared/model";
import { urls } from "../../shared/api";
import { destinations, fileInput, signedIn, textFile, unique } from "./helpers";

async function completedShare(page: Page, alreadySignedIn = false) {
  if (!alreadySignedIn) await signedIn(page);
  const filename = `${unique("handoff")}.txt`;
  await fileInput(page).setInputFiles(textFile(filename, "The saved fixture must stay intact."));
  await destinations(page).getByRole("button", { name: "Create link", exact: true }).click();
  const result = page.locator(".transfer").first();
  await expect(result.getByRole("button", { name: "Copy link" })).toBeVisible();
  await expect(result.getByRole("img", { name: "QR code for this link" })).toBeVisible();
  const links: Link[] = await (await page.request.get("/api/links")).json();
  const link = links.find((l) => l.item?.name === filename)!;
  expect(link).toBeTruthy();
  const session = await (await page.request.get("/api/session")).json();
  return { result, link, headers: { "X-Relay-CSRF": session.csrf } };
}

for (const change of ["revoke", "trash"] as const) {
  test(`completed Send stops offering a dead handoff after ${change} while preserving saved content`, async ({
    page,
  }, testInfo) => {
    const { result, link, headers } = await completedShare(page);
    const response =
      change === "revoke"
        ? await page.request.delete(`/api/links/${link.id}`, { headers })
        : await page.request.post(`/api/items/${link.itemId}/trash`, { headers });
    expect(response.ok()).toBe(true);
    await expect(result.getByRole("button", { name: "Copy link" })).toHaveCount(0);
    await expect(result.getByRole("button", { name: "Copy code" })).toHaveCount(0);
    await expect(result.getByRole("img", { name: /QR code/ })).toHaveCount(0);
    await expect(result.getByRole("status").filter({ hasText: "turned off" })).toBeVisible();
    const item = await (await page.request.get(`/api/items/${link.itemId}`)).json();
    expect(item.nodes).toHaveLength(1);
    expect(item.trashed !== null).toBe(change === "trash");
    const content = await page.request.get(urls.nodeContent(item.nodes[0].id));
    expect(content.ok()).toBe(true);
    expect(await content.text()).toBe("The saved fixture must stay intact.");
    await page.screenshot({ path: testInfo.outputPath(`send-${change}.png`), animations: "disabled" });
  });
}

test("trash then permanent deletion never revives the original Send handoff", async ({ page }, testInfo) => {
  const { result, link, headers } = await completedShare(page);
  expect((await page.request.post(`/api/items/${link.itemId}/trash`, { headers })).ok()).toBe(true);
  await expect(result.getByRole("button", { name: "Copy link" })).toHaveCount(0);
  expect((await page.request.delete(`/api/items/${link.itemId}`, { headers })).ok()).toBe(true);
  await expect
    .poll(async () => (await (await page.request.get("/api/links")).json()).some((l: Link) => l.id === link.id))
    .toBe(false);
  await expect(result.getByRole("status").filter({ hasText: "no longer available" })).toBeVisible();
  await expect(result.getByRole("button", { name: "Copy link" })).toHaveCount(0);
  await expect(result.getByRole("button", { name: "Copy code" })).toHaveCount(0);
  await expect(result.getByRole("img", { name: /QR code/ })).toHaveCount(0);
  // A later failed refresh must retain the confirmed disappearance too.
  await page.route("**/api/links", (route) => route.fulfill({ status: 503, json: { error: "Fixture outage" } }));
  const failed = page.waitForResponse((response) => response.url().endsWith("/api/links") && response.status() === 503);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await failed;
  await expect(result.getByRole("button", { name: "Copy link" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("send-purged.png"), animations: "disabled" });
});

test("a new Send handoff survives initial loading and failed reads until a successful fresh response", async ({
  page,
}) => {
  await signedIn(page);
  const boot = await page.evaluate(() => performance.timeOrigin);
  const cachedRead = page.waitForResponse(
    (response) => response.url().endsWith("/api/links") && response.status() === 200,
  );
  await page.getByRole("link", { name: "Links", exact: true }).click();
  await (await cachedRead).finished();
  await expect(page.getByRole("heading", { name: "Links", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Send", exact: true }).click();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(boot);
  // The cached list predates this new link: its absence cannot retire a confirmed creation.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/links", async (route) => {
    await held;
    await route.fulfill({ status: 503, json: { error: "Fixture outage" } });
  });
  try {
    const { result } = await completedShare(page, true);
    const initialFailure = page.waitForResponse(
      (response) => response.url().endsWith("/api/links") && response.status() === 503,
    );
    release();
    await initialFailure;
    await expect(result.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(result.getByRole("img", { name: "QR code for this link" })).toBeVisible();
    const failed = page.waitForResponse(
      (response) => response.url().endsWith("/api/links") && response.status() === 503,
    );
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await failed;
    await expect(result.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(result.getByText("This link is no longer available.", { exact: true })).toHaveCount(0);
    await page.unroute("**/api/links");
    const recovered = page.waitForResponse(
      (response) => response.url().endsWith("/api/links") && response.status() === 200,
    );
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await recovered;
    await expect(result.getByRole("button", { name: "Copy link" })).toBeVisible();
  } finally {
    release();
  }
});

test("permanent deletion before the first link-list response is authoritative after loading", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/links", async (route) => {
    await held;
    await route.fulfill({ json: [] });
  });
  try {
    const { result, link, headers } = await completedShare(page);
    expect((await page.request.post(`/api/items/${link.itemId}/trash`, { headers })).ok()).toBe(true);
    expect((await page.request.delete(`/api/items/${link.itemId}`, { headers })).ok()).toBe(true);
    const read = page.waitForResponse((response) => response.url().endsWith("/api/links") && response.status() === 200);
    release();
    await read;
    await expect(result.getByRole("status").filter({ hasText: "no longer available" })).toBeVisible();
    await expect(result.getByRole("button", { name: "Copy link" })).toHaveCount(0);
    await expect(result.getByRole("img", { name: /QR code/ })).toHaveCount(0);
  } finally {
    release();
  }
});

for (const deadline of ["expires", "hardExpires"] as const) {
  test(`an item-only ${deadline} update retires Send's handoff on the client clock without a link event`, async ({
    page,
  }) => {
    const { result, link } = await completedShare(page);
    const now = Date.now();
    await page.clock.install({ time: now });
    const updated: Link = {
      ...link,
      expires: null,
      available: true,
      item: { ...link.item!, expires: null, hardExpires: null, [deadline]: now + 5000 },
    };
    let reads = 0;
    await page.route("**/api/links", async (route) => {
      reads++;
      await route.fulfill({ json: [updated] });
    });
    // A real unrelated item rename publishes only the ordinary item change that this panel must follow.
    const session = await (await page.request.get("/api/session")).json();
    expect(
      (
        await page.request.patch(`/api/items/${link.itemId}`, {
          headers: { "X-Relay-CSRF": session.csrf },
          data: { name: "Renamed saved fixture" },
        })
      ).ok(),
    ).toBe(true);
    await page.clock.runFor(1500);
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect(result.getByRole("button", { name: "Copy link" })).toBeVisible();
    await page.clock.runFor(5000);
    await expect(result.getByRole("button", { name: "Copy link" })).toHaveCount(0);
    await expect(result.getByRole("status").filter({ hasText: "expired" })).toBeVisible();
  });
}
