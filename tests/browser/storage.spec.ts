import { test, expect, type Browser, type Page } from "@playwright/test";
import { api } from "../../shared/api.ts";
import type { ItemPage } from "../../shared/model.ts";
import { BASE, composer, destinations, fileInput, signedIn, unique } from "./helpers";

const MB = 1024 ** 2;

/** A new member, invited with a 10 MB storage limit, so what they keep is theirs alone. */
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
    data: { token, username: unique("storage").toLowerCase(), password: "Browser-test-password-only" },
  });
  expect(joined.ok()).toBe(true);
  const page = await context.newPage();
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  return { context, page };
}

async function save(page: Page, name: string, size: number) {
  await fileInput(page).setInputFiles([{ name, mimeType: "application/pdf", buffer: Buffer.alloc(size, 7) }]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
}

test("a member sees what fills their space, empties Trash and downloads everything, from Settings", async ({
  page,
  browser,
}) => {
  await signedIn(page);
  const { context, page: member } = await limitedMember(page, browser);
  try {
    const report = `${unique("report")}.pdf`;
    const draft = `${unique("draft")}.pdf`;
    await save(member, report, 2 * MB);
    await save(member, draft, 1 * MB);
    // Put the draft in Trash, the way the Files page would.
    const session = await (await member.request.get(api.session.get.path)).json();
    const items: ItemPage = await (await member.request.get(api.items.list.path)).json();
    const trashed = items.items.find((item) => item.name === draft)!;
    const moved = await member.request.post(api.items.trash.path.replace(":id", trashed.id), {
      headers: { "X-Relay-CSRF": session.csrf },
    });
    expect(moved.ok()).toBe(true);

    // The account menu says how full their storage is; Settings › Storage says what fills it.
    await member.getByRole("button", { name: /^Account/ }).click();
    await expect(member.getByRole("menuitem", { name: /^Usage/ })).toContainText("3 MB of 10 MB");
    await member.keyboard.press("Escape");
    await member.goto("/settings#s-storage");
    const storage = member.getByRole("region", { name: "Storage", exact: true });
    await expect(storage).toContainText("3 MB of 10 MB used");

    // The biggest things come first; Trash says it still takes space.
    const largest = storage.getByRole("list", { name: "Largest in Files" });
    await expect(largest.getByRole("listitem").first()).toContainText(report);
    await expect(largest).not.toContainText(draft);
    await expect(storage).toContainText("1 item · 1 MB. Items in Trash still use your space");

    await storage.getByRole("button", { name: "Empty Trash" }).click();
    await member.getByRole("dialog", { name: "Empty Trash?" }).getByRole("button", { name: "Empty Trash" }).click();
    await expect(storage).toContainText("Trash is empty.");
    await expect(storage).toContainText("2 MB of 10 MB used");

    // Everything in Files comes down as one ZIP.
    const download = member.waitForEvent("download");
    await storage.getByRole("button", { name: "Download ZIP" }).click();
    expect((await download).suggestedFilename()).toMatch(/^Relay - storage-.+ - \d{4}-\d{2}-\d{2}\.zip$/);
  } finally {
    await context.close();
  }
});
