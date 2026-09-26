import { test, expect, type Page } from "@playwright/test";
import type { PublicShare } from "../../shared/model";
import { signedIn } from "./helpers";

type Surface = "public link" | "public pickup" | "in-app pickup";
const recovered: PublicShare = {
  from: "Tester",
  name: "Recovered share",
  note: "",
  expires: Date.now() + 86_400_000,
  files: 0,
  texts: 1,
  bytes: 14,
  nodes: [
    {
      id: "recovered-text",
      kind: "text",
      name: "Text.txt",
      path: "Text.txt",
      size: 14,
      mime: "text/plain",
      parent: null,
      created: Date.now(),
      text: "Recovered text",
    },
  ],
};

async function openShare(page: Page, surface: Surface, token: string) {
  if (surface === "public link") {
    await page.goto(`/s/${token}`);
    return;
  }
  await page.route("**/api/pickup", (route) => route.fulfill({ json: { kind: "share", path: `/s/${token}` } }));
  if (surface === "public pickup") {
    await page.goto("/pickup");
    await page.getByLabel("Pickup code").fill("234567");
  } else {
    await signedIn(page);
    await page.getByRole("button", { name: "Enter code", exact: true }).click();
    await page.getByRole("dialog", { name: "Enter a code" }).getByRole("textbox").fill("234567");
  }
}

for (const surface of ["public link", "public pickup", "in-app pickup"] as const) {
  test(`${surface} retries a temporary share failure without reloading or entering the code again`, async ({
    page,
  }) => {
    let fail = true;
    let attempts = 0;
    await page.route("**/api/s/retry-share", (route) => {
      attempts++;
      if (!fail) return route.fulfill({ json: recovered });
      return surface === "in-app pickup"
        ? route.abort()
        : route.fulfill({ status: 503, json: { error: "Temporary share outage" } });
    });
    await openShare(page, surface, "retry-share");
    await expect(page.getByRole("heading", { name: "Link unavailable", exact: true })).toBeVisible();
    await expect(
      page.getByText(surface === "in-app pickup" ? "Relay couldn’t be reached." : "Temporary share outage", {
        exact: true,
      }),
    ).toBeVisible();
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    const beforeRetry = attempts;
    await page.evaluate(() => ((window as Window & { careShareRetry?: boolean }).careShareRetry = true));
    fail = false;
    await retry.click();
    await expect(page.getByRole("heading", { name: recovered.name, exact: true })).toBeVisible();
    await expect(retry).toHaveCount(0);
    expect(attempts).toBe(beforeRetry + 1);
    expect(await page.evaluate(() => (window as Window & { careShareRetry?: boolean }).careShareRetry)).toBe(true);
  });
}

for (const status of [401, 403, 404, 410]) {
  test(`a permanent public share failure (${status}) does not offer Retry`, async ({ page }) => {
    await page.route("**/api/s/permanent-share", (route) =>
      route.fulfill({ status, json: { error: "This share is unavailable to this browser." } }),
    );
    await openShare(page, "public link", "permanent-share");
    await expect(page.getByRole("heading", { name: "Link unavailable", exact: true })).toBeVisible();
    await expect(
      page.getByText(
        status === 404 || status === 410
          ? "This link has expired or was removed. Ask the person who sent it for a new one."
          : "This share is unavailable to this browser.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Have a pickup code?", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Use a code", exact: true })).toBeVisible();
  });
}

for (const surface of ["public pickup", "in-app pickup"] as const) {
  test(`${surface} keeps expired-link guidance and its exit action`, async ({ page }) => {
    await page.route("**/api/s/expired-share", (route) =>
      route.fulfill({ status: 410, json: { error: "The content of this link is no longer available." } }),
    );
    await openShare(page, surface, "expired-share");
    await expect(page.getByRole("heading", { name: "Link unavailable", exact: true })).toBeVisible();
    await expect(
      page.getByText(
        surface === "public pickup"
          ? "This link has expired or was removed. Ask the person who sent it for a new one."
          : "This link has expired or was turned off.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    if (surface === "public pickup") {
      await page.getByRole("button", { name: "Try another code", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Use a code", exact: true })).toBeVisible();
      await expect(page.getByLabel("Pickup code")).toHaveValue("");
    } else {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Link unavailable" })).toHaveCount(0);
    }
  });
}
