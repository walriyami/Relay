import { test, expect, type Page } from "@playwright/test";
import type { Link } from "../../shared/model";
import { urls } from "../../shared/api";
import { destinations, fileInput, signedIn, textFile, unique } from "./helpers";

async function completedShare(page: Page) {
  await signedIn(page);
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
