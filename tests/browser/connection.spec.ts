import { test, expect, type Page, type Route } from "@playwright/test";
import { destinations, signedIn, writeText } from "./helpers";

// What the tunnel in front of Relay answers when Relay itself is down: its own page, not Relay's JSON.
const PROXY_PAGE = "<html><body>Bad gateway</body></html>";

const bar = (page: Page) => page.locator(".conn-bar");

/** Every API request (and the event stream) fails the way `how` says, until the returned function is called. */
async function breakRelay(page: Page, how: "down" | "no-network") {
  const handler = (route: Route) =>
    how === "down"
      ? route.fulfill({ status: 502, contentType: "text/html", body: PROXY_PAGE })
      : route.abort("internetdisconnected");
  await page.route("**/api/**", handler);
  return () => page.unroute("**/api/**", handler);
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test("when Relay is down, one bar says it's Relay's side, Send pauses, and it all comes back by itself", async ({
  page,
}) => {
  await writeText(page, "held while Relay is down");
  const save = destinations(page).getByRole("button", { name: "Save to Files" });
  await expect(save).toBeEnabled();

  const restore = await breakRelay(page, "down");
  // Any failed request is enough to find out; the event stream usually notices first.
  await page.getByRole("link", { name: "Files" }).click();
  await expect(bar(page)).toContainText("Relay is down.");
  await expect(bar(page)).toContainText("Your internet is working");
  await expect(bar(page).getByRole("button", { name: "Try now" })).toBeVisible();
  // The one place that retries: views wait quietly without their own errors or Retry buttons.
  await expect(page.getByRole("main").getByRole("button", { name: /Retry|Try now/ })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);

  await page.getByRole("link", { name: "Send", exact: true }).click();
  await expect(save).toBeDisabled();
  await expect(page.getByRole("complementary", { name: "Send to" })).toContainText(
    "Sending is paused until Relay is back",
  );

  // "Try now" checks at once; while Relay is still down that only restarts the countdown.
  await bar(page).getByRole("button", { name: "Try now" }).click();
  await expect(bar(page)).toContainText(/Checking…|Trying again in \d+ s/);
  await expect(bar(page)).toContainText("Relay is down.");

  // No one has to press anything once it's back.
  await restore();
  await expect(bar(page)).toContainText("Relay is back.", { timeout: 20_000 });
  await expect(save).toBeEnabled();
  await expect(bar(page)).toHaveCount(0, { timeout: 6_000 });
});

test("when nothing gets through, the bar points at this device's connection", async ({ page }) => {
  const restore = await breakRelay(page, "no-network");
  await page.getByRole("link", { name: "Links" }).click();
  await expect(bar(page)).toContainText("Your connection isn’t getting through.");
  await expect(bar(page)).toContainText(/Trying again in \d+ s/);
  await expect(page.getByText("Waiting for your connection")).toBeVisible();
  await restore();
  await expect(bar(page)).toContainText("You’re back online.", { timeout: 20_000 });
  await expect(page.getByText("Waiting for your connection")).toHaveCount(0);
});

test("offline, the bar says so without a retry: the browser says when it's back", async ({ page }) => {
  await page.context().setOffline(true);
  await expect(bar(page)).toContainText("You’re offline.");
  await expect(bar(page).getByRole("button", { name: "Try now" })).toHaveCount(0);
  await page.context().setOffline(false);
  await expect(bar(page)).toContainText("You’re back online.");
});

test("a single failed request that the health check clears shows nothing", async ({ page }) => {
  let failures = 0;
  await page.route("**/api/links", (route) =>
    failures++ ? route.continue() : route.fulfill({ status: 502, contentType: "text/html", body: PROXY_PAGE }),
  );
  await page.getByRole("link", { name: "Links" }).click();
  await expect(page.getByRole("heading", { name: "Links" })).toBeVisible();
  // The check finds Relay fine, so the page loads again by itself and no bar ever appears.
  await expect.poll(() => failures).toBeGreaterThan(1);
  await expect(page.getByText("Links couldn’t be loaded")).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
});

test("a tab that can't open Relay at all shows where the break is and opens once it can", async ({ page }) => {
  const restore = await breakRelay(page, "down");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Relay is down" })).toBeVisible();
  await expect(page.locator(".conn-screen .conn-hop.is-broken")).toHaveCount(1);
  await restore();
  await expect(destinations(page)).toBeVisible({ timeout: 20_000 });
});
