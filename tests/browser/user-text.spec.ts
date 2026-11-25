import { test, expect } from "@playwright/test";
import { signedIn, unique } from "./helpers";

// Words people choose are set apart from Relay's own, so right-to-left letters (or a direction
// override stored before the server dropped them) can't reorder the sentence around them.
test("names and notes people chose are isolated from the text around them", async ({ page, browser }) => {
  await signedIn(page);
  const session = await (await page.request.get("/api/session")).json();
  const name = `${unique("rtl")} تقرير 2024`;
  const response = await page.request.post("/api/requests", {
    headers: { "X-Relay-CSRF": session.csrf },
    data: { id: crypto.randomUUID(), name, description: "שלום 3 files", days: 7, maxBytes: 1024 },
  });
  expect(response.ok()).toBe(true);
  const { token } = (await response.json()) as { token: string };

  const visitor = await browser.newContext();
  const guest = await visitor.newPage();
  await guest.goto(`/r/${token}`);
  const isolated = (selector: string) =>
    guest.locator(selector).evaluate((el) => (el.tagName === "BDI" ? getComputedStyle(el).unicodeBidi : "none"));
  await expect(guest.getByRole("heading", { name })).toBeVisible();
  expect(await isolated("h1 bdi")).toBe("isolate");
  expect(await isolated(".request-description bdi")).toBe("isolate");
  expect(await isolated(".request-owner bdi")).toBe("isolate");
  await expect(guest.locator(".request-owner")).toContainText("is asking for");
  await visitor.close();

  // The owner's own list shows it the same way.
  await page.getByRole("link", { name: "Requests" }).click();
  const row = page.getByRole("list", { name: "Open requests" }).getByRole("listitem").filter({ hasText: name });
  await expect(row.locator("bdi").filter({ hasText: name })).toHaveCount(1);
});
