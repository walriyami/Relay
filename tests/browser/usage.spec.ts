import { test, expect, type Browser, type Page } from "@playwright/test";
import { api } from "../../shared/api.ts";
import { BASE, composer, destinations, fileInput, signedIn, unique } from "./helpers";

const MB = 1024 ** 2;

/** A new member, invited with a 10 MB storage limit, so what they keep and move is theirs alone. */
async function limitedMember(admin: Page, browser: Browser) {
  const session = await (await admin.request.get(api.session.get.path)).json();
  const invite = await admin.request.post(api.admin.invite.path, {
    headers: { "X-Relay-CSRF": session.csrf },
    data: { limits: { storage: 10 * MB, keepDays: null, linkDays: null } },
  });
  expect(invite.ok()).toBe(true);
  const { token } = await invite.json();
  const context = await browser.newContext({ baseURL: BASE });
  const joined = await context.request.post(api.session.join.path, {
    data: { token, username: unique("usage").toLowerCase(), password: "Browser-test-password-only" },
  });
  expect(joined.ok()).toBe(true);
  const page = await context.newPage();
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  return { context, page };
}

test("a member sees what they keep and what they moved, from the account menu", async ({ page, browser }) => {
  await signedIn(page);
  const { context, page: member } = await limitedMember(page, browser);
  try {
    await fileInput(member).setInputFiles([
      { name: `${unique("report")}.pdf`, mimeType: "application/pdf", buffer: Buffer.alloc(2 * MB, 7) },
    ]);
    await destinations(member).getByRole("button", { name: "Save to Files" }).click();
    await expect(member.locator(".transfer").first()).toContainText("Saved to Files");

    // The account menu says how full their storage is, and opens the rest.
    await member.getByRole("button", { name: /^Account/ }).click();
    const usage = member.getByRole("menuitem", { name: /^Usage/ });
    await expect(usage).toContainText("2 MB of 10 MB");
    await usage.click();
    await expect(member).toHaveURL(/\/usage$/);
    await expect(member.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();

    const storage = member.getByRole("region", { name: "Storage", exact: true });
    await expect(storage).toContainText("2 MB of 10 MB used");
    await expect(storage.getByRole("img", { name: /^Your storage: 2 MB of 10 MB, Documents 2 MB/ })).toBeVisible();
    await expect(storage).toContainText("8 MB left of your 10 MB.");

    const figures = member.getByRole("list", { name: "Over the last 30 days" });
    await expect(figures.getByRole("listitem").filter({ hasText: "Uploaded" })).toContainText("2 MB");
    await expect(figures.getByRole("listitem").filter({ hasText: "Shared" })).toContainText("0 B");
    await expect(member.getByRole("group", { name: /^Data moved each day/ })).toBeVisible();

    // Another period is one choice away, and counts by month.
    await member.getByRole("radio", { name: "12 months" }).click();
    await expect(member.getByRole("list", { name: "Over the last 12 months" })).toBeVisible();
    await expect(member.getByRole("group", { name: /^Data moved each month/ })).toBeVisible();
  } finally {
    await context.close();
  }
});
