import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyShareUrl, destinations, signedIn, unique, writeText } from "./helpers";

test("a shared item that is one folder opens inside it, with a breadcrumb back", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Directory inputs are only automatable in Chromium");
  await signedIn(page);
  const album = unique("Album");
  const dir = await mkdtemp(join(tmpdir(), "relay-share-folder-"));
  await mkdir(join(dir, album, "inner"), { recursive: true });
  await writeFile(join(dir, album, "one.txt"), "1");
  await writeFile(join(dir, album, "inner", "two.txt"), "2");
  await page.getByTestId("folder-input").setInputFiles(join(dir, album));
  await destinations(page).getByRole("button", { name: "Create link" }).click();
  const card = page.locator(".transfer").first();
  await expect(card).toContainText("Link ready");
  const url = await copyShareUrl(card);

  const visitor = await page.context().browser()!.newContext();
  const guest = await visitor.newPage();
  await guest.goto(url);
  // Straight into the folder: its files, not a lone folder tile.
  await expect(guest.locator(".tile-name", { hasText: "one.txt" })).toBeVisible();
  await expect(guest.locator(".tile-name", { hasText: "inner" })).toBeVisible();
  await expect(guest.locator(".tile-name", { hasText: album })).toHaveCount(0);
  await guest.locator(".tile-open", { hasText: "inner" }).click();
  const crumbs = guest.getByRole("navigation", { name: "Folder" });
  await expect(crumbs.getByRole("button", { name: album })).toBeVisible();
  await expect(crumbs.locator("[aria-current=page]")).toHaveText("inner");
  await expect(guest.locator(".tile-name", { hasText: "two.txt" })).toBeVisible();
  await crumbs.getByRole("button", { name: album }).click();
  await expect(guest.locator(".tile-name", { hasText: "one.txt" })).toBeVisible();
  await visitor.close();
});

test("the pickup code field shows six segments and keeps keyboard editing in place", async ({ page }) => {
  await page.route("**/api/pickup", (route) => route.fulfill({ status: 404, json: { error: "No match" } }));
  await page.goto("/pickup");
  const input = page.getByLabel("Pickup code");
  const boxes = page.locator(".code-entry-field-slot");
  const caret = () => input.evaluate((el: HTMLInputElement) => el.selectionStart);
  await expect(boxes).toHaveCount(6);
  await expect(input).toHaveAttribute("inputmode", "numeric");
  await input.pressSequentially("012345");
  await expect(input).toHaveValue("012-345");
  await expect(boxes).toHaveText(["0", "1", "2", "3", "4", "5"]);
  await expect(page.getByRole("alert")).toHaveText("That code isn’t valid or has expired.");
  await expect(page.getByRole("button", { name: /open|continue/i })).toHaveCount(0);
  expect(await boxes.nth(5).evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
  await boxes.nth(3).click({ force: true });
  expect(await caret()).toBe(4);
  await input.pressSequentially("9");
  await expect(input).toHaveValue("012-945");
  await input.press("ArrowLeft");
  await input.press("ArrowLeft");
  await input.pressSequentially("8");
  await expect(input).toHaveValue("018-945");
  await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(4, 4));
  await input.press("Backspace");
  await expect(input).toHaveValue("019-45");
  expect(await caret()).toBe(2);
});

test("typing a valid code opens its destination once without a submit button", async ({ page }) => {
  const attempts: string[] = [];
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => (releaseResponse = resolve));
  await page.route("**/api/pickup", async (route) => {
    attempts.push(route.request().postDataJSON().code);
    await responseGate;
    await route.fulfill({ json: { kind: "share", path: "/s/auto-typed" } });
  });
  await page.route("**/api/s/auto-typed", (route) => route.fulfill({ status: 404, json: { error: "Gone" } }));
  await page.goto("/pickup");
  const input = page.getByLabel("Pickup code");
  await input.pressSequentially("234567");
  try {
    await expect(page.getByRole("status").and(page.locator(".field-hint"))).toHaveText("Checking code…");
    await expect(input).toHaveAttribute("aria-busy", "true");
    await expect(input).toBeEditable();
    await expect.poll(() => attempts).toEqual(["234567"]);
  } finally {
    releaseResponse();
  }
  await expect(page.getByRole("heading", { name: "Link unavailable" })).toBeVisible();
  expect(attempts).toEqual(["234567"]);
  await expect(page.getByRole("button", { name: /open|continue/i })).toHaveCount(0);
});

test("pasting a valid code submits automatically and invalid alphabet characters do not submit", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Clipboard paste automation is only reliable in Chromium");
  const attempts: string[] = [];
  await page.route("**/api/pickup", async (route) => {
    attempts.push(route.request().postDataJSON().code);
    await route.fulfill({ json: { kind: "share", path: "/s/auto-paste" } });
  });
  await page.route("**/api/s/auto-paste", (route) => route.fulfill({ status: 404, json: { error: "Gone" } }));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/pickup");
  const input = page.getByLabel("Pickup code");
  await input.fill("O12345");
  expect(attempts).toEqual([]);
  await page.evaluate(() => navigator.clipboard.writeText("234 567"));
  await input.press("ControlOrMeta+V");
  await expect(page.getByRole("heading", { name: "Link unavailable" })).toBeVisible();
  expect(attempts).toEqual(["234567"]);
});

test("a failed code stays editable and a correction retries automatically", async ({ page }) => {
  const attempts: string[] = [];
  await page.route("**/api/pickup", async (route) => {
    attempts.push(route.request().postDataJSON().code);
    if (attempts.length === 1) {
      await route.fulfill({ status: 404, json: { error: "No match" } });
      return;
    }
    await route.fulfill({ json: { kind: "share", path: "/s/auto-retry" } });
  });
  await page.route("**/api/s/auto-retry", (route) => route.fulfill({ status: 404, json: { error: "Gone" } }));
  await page.goto("/pickup");
  const input = page.getByLabel("Pickup code");
  await input.pressSequentially("234567");
  await expect(page.getByRole("alert")).toHaveText("That code isn’t valid or has expired.");
  await expect(input).toHaveValue("234-567");
  await expect(input).toBeEditable();
  await input.fill("234568");
  await expect(page.getByRole("heading", { name: "Link unavailable" })).toBeVisible();
  expect(attempts).toEqual(["234567", "234568"]);
});

test("a correction during lookup ignores the stale destination and resolves the latest code", async ({ page }) => {
  let releaseFirst!: () => void;
  const firstResponseGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  const attempts: string[] = [];
  const openedPaths: string[] = [];
  await page.route("**/api/pickup", async (route) => {
    const code = route.request().postDataJSON().code;
    attempts.push(code);
    if (attempts.length === 1) {
      await firstResponseGate;
      await route.fulfill({ json: { kind: "share", path: "/s/stale-response" } });
      return;
    }
    await route.fulfill({ json: { kind: "share", path: "/s/latest-response" } });
  });
  await page.route("**/api/s/*", async (route) => {
    openedPaths.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 404, json: { error: "Gone" } });
  });
  await page.goto("/pickup");
  const input = page.getByLabel("Pickup code");
  await input.pressSequentially("234567");
  await expect(page.getByRole("status").and(page.locator(".field-hint"))).toHaveText("Checking code…");
  await expect.poll(() => attempts).toEqual(["234567"]);
  await input.fill("234568");
  await expect(input).toHaveValue("234-568");
  await expect(input).toBeEditable();
  expect(attempts).toEqual(["234567"]);
  releaseFirst();
  await expect(page.getByRole("heading", { name: "Link unavailable" })).toBeVisible();
  expect(attempts).toEqual(["234567", "234568"]);
  expect(openedPaths).toEqual(["/api/s/latest-response"]);
});

test("a valid prefilled sign-in code resolves once on mount", async ({ page }) => {
  const attempts: string[] = [];
  await page.route("**/api/pickup", async (route) => {
    attempts.push(route.request().postDataJSON().code);
    await route.fulfill({ json: { kind: "share", path: "/s/auto-prefill" } });
  });
  await page.route("**/api/s/auto-prefill", (route) => route.fulfill({ status: 404, json: { error: "Gone" } }));
  await page.goto("/?login=234-567");
  await expect(page).toHaveURL(/\/s\/auto-prefill$/);
  await expect(page.getByRole("heading", { name: "Link unavailable" })).toBeVisible();
  expect(attempts).toEqual(["234567"]);
});

test("the signed-in Enter code button uses the same six-box code field", async ({ page }) => {
  await page.route("**/api/pickup", (route) => route.fulfill({ status: 404, json: { error: "No match" } }));
  await signedIn(page);
  const button = page.getByRole("button", { name: "Enter code" });
  await button.click();
  const popover = page.getByRole("dialog", { name: "Enter a code" });
  const input = popover.getByRole("textbox", { name: "Code" });
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(popover.locator(".code-entry-field-slot")).toHaveCount(6);
  await input.pressSequentially("123456");
  await expect(input).toHaveValue("123-456");
  await expect(popover.getByRole("alert")).toHaveText("That code isn’t valid or has expired.");
  await input.press("Backspace");
  await expect(input).toHaveValue("123-45");
  await expect(popover.getByRole("alert")).toHaveCount(0);
  const boxes = (await popover.locator(".code-entry-field-boxes").boundingBox())!;
  const box = (await popover.boundingBox())!;
  expect(boxes.x).toBeGreaterThanOrEqual(box.x);
  expect(boxes.x + boxes.width).toBeLessThanOrEqual(box.x + box.width);
  // Clicking anywhere else closes it.
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await expect(popover).toHaveCount(0);
  await expect(button).toHaveAttribute("aria-expanded", "false");
});

test("text is named by its length; only the card preview shows a short excerpt", async ({
  page,
  context,
  browserName,
}) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signedIn(page);
  const secret = unique("hunter");
  const text = `Wi-Fi: relay-guest / password ${secret}`;
  const label = `Text · ${[...text].length} characters`;
  await writeText(page, text);
  await destinations(page).getByRole("button", { name: "Create link" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Link ready");

  const recent = page.getByRole("list", { name: "Recent" });
  const card = recent.locator(".collection-card", { hasText: label }).first();
  await expect(card.locator(".card-title")).toHaveText(label);
  // The contract's bounded preview: a short excerpt in the (decorative) thumbnail, never in the name.
  await expect(card.locator(".thumb-text")).toContainText("Wi-Fi");
  await expect(card.locator(".card-title")).not.toContainText(secret);
  expect(await card.getByRole("button").first().getAttribute("aria-label")).not.toContain(secret);

  await page.getByRole("link", { name: "Links" }).click();
  const links = page.getByRole("list", { name: "Active links" });
  await expect(links).toContainText(label);
  await expect(links).not.toContainText(secret);

  await page.getByRole("link", { name: "Files" }).click();
  const files = page.getByRole("list", { name: "Files" });
  await expect(files.locator(".collection-card", { hasText: label }).first()).toBeVisible();
  await expect(files.locator(".card-title", { hasText: secret })).toHaveCount(0);

  // Copy text still copies the text itself.
  const fileCard = files.locator(".collection-card", { hasText: label }).first();
  await fileCard.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Copy text" }).click();
  await expect(page.locator(".toast", { hasText: "Text copied" })).toBeVisible();
  if (browserName === "chromium") expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

  // The popup is where the text is shown.
  await fileCard.locator(".card-open").click();
  await expect(page.getByRole("dialog").getByRole("region", { name: "Text" })).toContainText(text);
});
