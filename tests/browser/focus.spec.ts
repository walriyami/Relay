import { test, expect, type Page } from "@playwright/test";
import { destinations, fileInput, signedIn, textFile, unique } from "./helpers";

// Keyboard focus is never dropped to <body>, where the next Tab starts again from the top.
const focusIsKept = (page: Page) =>
  expect.poll(() => page.evaluate(() => !!document.activeElement && document.activeElement !== document.body));

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test("closing the link of a new request returns focus to the page", async ({ page }) => {
  await page.getByRole("link", { name: "Requests" }).click();
  await page.getByRole("button", { name: "New request" }).first().press("Enter");
  await page.getByLabel("What are you asking for?").fill(unique("focus-request"));
  await page.getByRole("button", { name: "Create request" }).press("Enter");
  await expect(page.getByRole("dialog").getByRole("img", { name: "QR code for this upload request" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await focusIsKept(page).toBe(true);
  expect(await page.evaluate(() => !!document.activeElement?.closest("#main"))).toBe(true);
});

test("choosing a destination from the keyboard moves focus to its result", async ({ page }) => {
  await fileInput(page).setInputFiles([textFile(`${unique("focus-dest")}.txt`)]);
  const save = destinations(page).getByRole("button", { name: "Save to Files" });
  await save.press("Enter");
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  // Completed destinations leave the panel; focus follows to the useful result action.
  await expect(save).toHaveCount(0);
  await expect(page.locator(".composer").getByRole("button", { name: "Done" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".composer")).toContainText("Nothing added yet");
  await expect(page.locator(".transfer")).toHaveCount(0);
});

test("creating a link from the keyboard lands on Copy link", async ({ page }) => {
  await page.getByRole("group", { name: "Content type" }).getByRole("button", { name: "Text" }).click();
  await page.locator("#composer-text").fill(unique("phone-link"));
  await destinations(page).getByRole("button", { name: "Create link" }).press("Enter");
  await expect(page.locator(".composer").getByRole("button", { name: "Copy link" })).toBeFocused();
});

test("a new link's QR and code sit centred in the transfer", async ({ page, isMobile }) => {
  test.skip(isMobile, "Full width on phones");
  await page.getByRole("group", { name: "Content type" }).getByRole("button", { name: "Text" }).click();
  await page.locator("#composer-text").fill(unique("centred-link"));
  await destinations(page).getByRole("button", { name: "Create link" }).click();
  const panel = page.locator(".composer .share-access");
  await expect(panel).toBeVisible();
  const [inner, outer] = await Promise.all([
    panel.boundingBox(),
    page.locator(".composer .transfer-embedded").boundingBox(),
  ]);
  const left = inner!.x - outer!.x;
  const right = outer!.x + outer!.width - (inner!.x + inner!.width);
  expect(Math.abs(left - right)).toBeLessThan(4);
});

test("a slow paste keeps focus on Paste until the clipboard answers", async ({ page }) => {
  await page.evaluate(() => {
    navigator.clipboard.readText = () => new Promise((resolve) => setTimeout(() => resolve("pasted later"), 1800));
  });
  await page.getByRole("group", { name: "Content type" }).getByRole("button", { name: "Text" }).click();
  // Text mode focuses the box first.
  await expect(page.locator("#composer-text")).toBeFocused();
  const paste = page.getByRole("button", { name: "Paste" });
  await paste.press("Enter");
  await expect(paste).toHaveAttribute("aria-disabled", "true");
  await page.waitForTimeout(1300);
  await expect(paste).toBeFocused();
  await expect(page.locator("#composer-text")).toHaveValue("pasted later");
  await expect(page.locator("#composer-text")).toBeFocused();
});

test("when the clipboard can't be read, the text box takes focus for a manual paste", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Clipboard permissions are only controllable in Chromium");
  await page.context().clearPermissions();
  await page.evaluate(() => {
    navigator.clipboard.readText = () => Promise.reject(new DOMException("Denied", "NotAllowedError"));
  });
  await page.getByRole("group", { name: "Content type" }).getByRole("button", { name: "Text" }).click();
  await page.getByRole("button", { name: "Paste" }).click();
  await expect(page.getByText("won’t let Relay read the clipboard")).toBeVisible();
  await expect(page.locator("#composer-text")).toBeFocused();
});

test("the item window's More menu returns focus to its button, and trashing lands back on the page", async ({
  page,
}) => {
  const name = unique("focus-popup");
  await fileInput(page).setInputFiles([textFile(`${name}-a.txt`), textFile(`${name}-b.txt`)]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await page
    .getByRole("list", { name: "Recent" })
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: new RegExp(name) });
  const more = dialog.getByRole("button", { name: "More actions" });
  await more.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(more).toBeFocused();

  await more.press("Enter");
  await page.getByRole("menu").getByRole("menuitem", { name: "Move to Trash", exact: true }).press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
});

test("on a narrow phone share handoff actions stay on screen", async ({ page }) => {
  const name = unique("narrow-link");
  await fileInput(page).setInputFiles([textFile(`${name}.txt`)]);
  await destinations(page).getByRole("button", { name: "Create link" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Link ready");
  await page.setViewportSize({ width: 320, height: 700 });
  const card = page.getByRole("list", { name: "Recent" }).locator(".collection-card", { hasText: name }).first();
  await card.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Share" }).click();
  const handoff = page.getByRole("dialog");
  for (const label of ["Copy code", "Copy link"]) {
    const action = handoff.getByRole("button", { name: label });
    await action.scrollIntoViewIfNeeded();
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  }
});

test("the tab title is Relay on every page, never the page's name", async ({ page }) => {
  await page.goto("/r/not-a-real-request-token-000000");
  await expect(page.getByRole("heading", { name: "Request unavailable" })).toBeVisible();
  await expect(page).toHaveTitle("Relay");
});

test("Tab and Shift+Tab never leave an open dialog for the page behind it", async ({ page }) => {
  const name = unique("tab-trap");
  await fileInput(page).setInputFiles([textFile(`${name}.txt`)]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await page.getByRole("link", { name: "Files" }).click();
  await page
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .press("Enter");
  const popup = page.getByRole("dialog").first();
  await popup.getByRole("button", { name: "Share", exact: true }).focus();
  const inDialog = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  for (const key of [...Array(12).fill("Tab"), ...Array(12).fill("Shift+Tab")]) {
    await page.keyboard.press(key);
    expect(
      await inDialog(),
      key + " " + (await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))),
    ).toBe(true);
  }
  // The page behind is out of reach while the dialog is open and comes back once it closes.
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("inert");
});

test("a popover takes focus when opened and hands it back when Tab leaves it", async ({ page }) => {
  const button = page.getByRole("button", { name: "Enter code" });
  await button.press("Enter");
  const popup = page.getByRole("dialog", { name: "Enter a code" });
  await expect(popup).toBeVisible();
  await expect.poll(() => popup.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect(popup).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("a choice of durations moves with the arrow keys and is one Tab stop", async ({ page }) => {
  await page.getByRole("link", { name: "Requests" }).click();
  await page.getByRole("button", { name: "New request" }).first().click();
  const group = page.getByRole("radiogroup", { name: "Stays open for" });
  const checked = group.getByRole("radio", { checked: true });
  await checked.focus();
  const before = await checked.textContent();
  await page.keyboard.press("ArrowRight");
  const now = group.getByRole("radio", { checked: true });
  await expect(now).not.toHaveText(before!);
  await expect(now).toBeFocused();
  expect(await group.locator('[tabindex="0"]').count()).toBe(1);
});
