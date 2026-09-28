import { expect, test } from "@playwright/test";
import { api } from "../../shared/api.ts";
import { BASE, copyShareUrl, destinations, signedIn, unique, writeText } from "./helpers";

test("attack notices reach members and guests while bearer links and QR stay available", async ({ page, browser }) => {
  const until = Date.now() + 15 * 60_000;
  // Exercise the presentation without locking the shared browser-test server's numeric namespace.
  const config = {
    codeLength: 6,
    protection: {
      preferredCodeLength: 4,
      pausedUntil: until,
      addressPausedUntil: null,
      heightenedUntil: until + 60 * 60_000,
      lastAttackAt: Date.now(),
      numericCodeResolutionUnavailable: false,
    },
  };
  await page.route(`**${api.pickup.config.path}`, (route) => route.fulfill({ json: config }));
  await signedIn(page, "Code protection member");
  await expect(page.getByText("Code entry is paused for everyone", { exact: false })).toBeVisible();
  await expect(page.getByText("Review your shared links", { exact: false })).toBeVisible();
  const content = unique("protection-fallback");
  await writeText(page, content);
  // A lost numeric assignment must not hide the independent bearer handoff.
  await page.route(`**${api.pickup.current.path}`, (route) => route.fulfill({ json: { code: null } }));
  await destinations(page).getByRole("button", { name: "Create link" }).click();
  const handoff = page.locator(".transfer").first();
  await expect(handoff.getByText("Code unavailable. Use the link or QR code.")).toBeVisible();
  await expect(handoff.getByRole("img", { name: "QR code for this link" })).toBeVisible();
  const url = await copyShareUrl(handoff);
  const visitor = await browser.newContext({ baseURL: BASE });
  try {
    const guest = await visitor.newPage();
    await guest.route(`**${api.pickup.config.path}`, (route) => route.fulfill({ json: config }));
    await guest.goto("/pickup");
    await expect(guest.getByText("Code entry is paused for everyone", { exact: false })).toBeVisible();
    await expect(guest.getByText("Codes have temporarily changed to six digits.", { exact: false })).toBeVisible();
    await expect(guest.locator(".code-entry-field-slot")).toHaveCount(6);
    await guest.goto(url);
    await expect(guest.getByRole("region", { name: "Text" })).toContainText(content);
  } finally {
    await visitor.close();
  }
});

test("guests and administrators can see when the four-digit namespace is exhausted", async ({ page, browser }) => {
  const config = {
    codeLength: 6,
    protection: {
      preferredCodeLength: 4,
      pausedUntil: null,
      addressPausedUntil: null,
      heightenedUntil: null,
      lastAttackAt: null,
      numericCodeResolutionUnavailable: false,
    },
  };
  await page.route(`**${api.pickup.config.path}`, (route) => route.fulfill({ json: config }));
  await signedIn(page, "Code capacity administrator");
  await page.route(`**${api.admin.overview.path}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: {
        ...(await response.json()),
        codeLength: 4,
        codeProtection: { ...config.protection, effectiveCodeLength: 6 },
      },
    });
  });
  await page.goto("/admin/settings");
  const codes = page.getByRole("region", { name: "Codes", exact: true });
  await expect(codes.getByText("Six-digit codes are active because", { exact: false })).toBeVisible();
  await expect(codes.getByRole("radio", { name: "4 digits · 1234" })).toBeChecked();

  const visitor = await browser.newContext({ baseURL: BASE });
  try {
    const guest = await visitor.newPage();
    await guest.route(`**${api.pickup.config.path}`, (route) => route.fulfill({ json: config }));
    await guest.goto("/pickup");
    await expect(guest.getByText("Six-digit codes are active because", { exact: false })).toBeVisible();
    await expect(guest.locator(".code-entry-field-slot")).toHaveCount(6);
    config.protection.numericCodeResolutionUnavailable = true;
    await guest.reload();
    await expect(guest.getByText("Code entry is unavailable because", { exact: false })).toBeVisible();
    await expect(guest.getByText("Links and QR codes keep working.", { exact: false })).toBeVisible();
  } finally {
    await visitor.close();
  }
});
