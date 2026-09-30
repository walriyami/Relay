import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { urls } from "../../shared/api";
import {
  BASE,
  copyShareUrl,
  composer,
  fileInput,
  png,
  recordWrites,
  isTransferWrite,
  selected,
  signedIn,
  textFile,
  unique,
  destinations,
  writeText,
} from "./helpers";

const pageWrites = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  pageWrites.set(page, recordWrites(page));
  await signedIn(page);
});

test("choosing files never uploads; picks accumulate until a destination is clicked", async ({ page }) => {
  const writes = pageWrites.get(page)!;
  expect(isTransferWrite("POST /api/nearby/presence")).toBe(false);
  for (const write of [
    "POST /api/transfers",
    "PATCH /uploads/test-id",
    "DELETE /api/uploads/test-id",
    "POST /api/transfers/test-id/complete",
    "POST /api/r/token/start",
    "POST /api/r/token/transfers",
    "POST /api/links",
    "POST /api/deliveries",
  ])
    expect(isTransferWrite(write), write).toBe(true);
  const presence = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/nearby/presence" && response.request().method() === "POST",
  );
  await page.goto("/nearby");
  expect((await presence).ok()).toBe(true);
  await page.goto("/");
  expect(writes).toContain("POST /api/nearby/presence");
  const a = unique("alpha");
  const b = unique("beta");
  const dir = await mkdtemp(join(tmpdir(), "relay-picks-"));
  await writeFile(join(dir, `${a}.txt`), "alpha");
  await fileInput(page).setInputFiles(join(dir, `${a}.txt`));
  await fileInput(page).setInputFiles([
    textFile(`${b}.txt`),
    { name: `${b}.png`, mimeType: "image/png", buffer: await png(40, 40) },
  ]);
  const list = selected(page);
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(composer(page)).toContainText("3 files");
  // Picking the same file again creates another independent row.
  await fileInput(page).setInputFiles(join(dir, `${a}.txt`));
  await expect(list.getByRole("listitem")).toHaveCount(4);
  await expect(list).toContainText(`${a} (2).txt`);
  await page.getByRole("button", { name: `Remove ${b}.png` }).click();
  await expect(list.getByRole("listitem")).toHaveCount(3);
  // Exactly one text box.
  await expect(page.locator("textarea")).toHaveCount(1);
  await writeText(page, "one message for the whole share");
  await page.waitForTimeout(1500);
  expect(writes.filter(isTransferWrite), "nothing is uploaded before a destination is chosen").toEqual([]);

  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  const card = page.locator(".transfer").first();
  await expect(card).toContainText("Saved to Files");
  expect(writes.filter(isTransferWrite)).toContain("POST /api/transfers");
  expect(writes.some((write) => /^PATCH \/uploads\//.test(write))).toBe(true);
  expect(writes.some((write) => /^POST \/api\/transfers\/[^/]+\/complete$/.test(write))).toBe(true);
  // The result replaces the picks inside the drop box; the draft is cleared.
  await expect(selected(page)).toHaveCount(0);
  await expect(page.locator("textarea")).toHaveCount(0);

  // It is saved in Files with the text shown inline, never as a .txt file.
  await page
    .getByRole("list", { name: "Recent" })
    .getByRole("button", { name: new RegExp(a) })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("region", { name: "Text" })).toContainText("one message for the whole share");
  await expect(dialog.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(dialog.locator(".tile-name", { hasText: `${a}.txt` })).toBeVisible();
});

test("create link copies a working link that shows text inline", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const name = unique("linked");
  await fileInput(page).setInputFiles([textFile(`${name}.txt`, "file body")]);
  await writeText(page, "hello link text");
  await destinations(page).getByRole("button", { name: "Create link" }).click();
  const card = page.locator(".transfer").first();
  await expect(card).toContainText("Link ready");
  const url = await copyShareUrl(card);
  expect(url).toMatch(/\/s\/[\w-]+$/);
  const code = (await card.locator(".share-access-code .code").textContent()) ?? "";
  expect(code).toMatch(/^[0-9]{3}-[0-9]{3}$/);
  const visitor = await page.context().browser()!.newContext();
  const guest = await visitor.newPage();
  await guest.goto(url);
  await expect(guest.getByRole("region", { name: "Text" })).toContainText("hello link text");
  // One file beside the text is shown as itself, large, rather than as a folder of one.
  await expect(guest.getByRole("region", { name: `Preview of ${name}.txt` })).toContainText("file body");
  await guest.getByRole("link", { name: "Relay home" }).click();
  await expect(guest).toHaveURL(`${BASE}/`);
  await expect(guest.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // The pickup code opens the same share; case and the dash don't matter.
  await guest.getByRole("textbox", { name: "Code" }).fill(code.replace("-", "").toLowerCase());
  await expect(guest.getByRole("region", { name: "Text" })).toContainText("hello link text");
  await guest.getByRole("link", { name: "Relay home" }).click();
  await expect(guest.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await visitor.close();
});

test("a saved transfer can get a link from the panel, shown in place", async ({ page }) => {
  const name = unique("save-then-link");
  await fileInput(page).setInputFiles([textFile(`${name}.txt`, "saved first")]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  const card = composer(page).locator(".transfer");
  await expect(card).toContainText("Saved to Files");
  await expect(destinations(page).getByRole("heading", { name: "Also send it to" })).toBeVisible();
  await destinations(page).getByRole("button", { name: "Create link" }).click();
  await expect(card).toContainText("Link ready");
  expect(await copyShareUrl(card)).toMatch(/\/s\/[\w-]+$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(destinations(page).getByRole("button", { name: "Create link" })).toHaveCount(0);
});

test("the next link's settings open from its row, which says what the link will be", async ({ page }) => {
  await writeText(page, unique("guarded"));
  const link = destinations(page).getByRole("button", { name: "Create link" });
  await expect(link).toHaveAccessibleDescription(/^(Expires in \d+ (day|days|year)|Never expires)$/);
  const button = destinations(page).getByRole("button", { name: "Link settings" });
  await button.click();
  const settings = page.getByRole("dialog", { name: "Link settings" });
  // "Add a note" and Done share the last line.
  await expect
    .poll(() =>
      settings.getByRole("button", { name: /^(Add a note|Done)$/ }).evaluateAll((buttons) => {
        if (buttons.length !== 2) return Infinity;
        const [add, done] = buttons.map((button) => button.getBoundingClientRect());
        return Math.abs(add.y + add.height / 2 - (done.y + done.height / 2));
      }),
    )
    .toBeLessThan(1);
  await settings.getByRole("switch", { name: /^Password/ }).click();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(link).toHaveAccessibleDescription(/ · Password$/);
  // Asking for the link without the password reopens the settings at the field that needs it.
  await link.click();
  const password = settings.getByRole("textbox", { name: "Link password" });
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(password).toHaveAccessibleDescription("Enter a password.");
  await password.fill("hunter22");
  await expect(password).toHaveAccessibleDescription(/^Tell it to the people you share with/);
  await password.press("Enter");
  await expect(settings).toHaveCount(0);
  await link.click();
  await expect(composer(page).locator(".transfer")).toContainText("Link ready");
});

test("a folder and files mix in one share", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Directory inputs are only automatable in Chromium");
  const dir = await mkdtemp(join(tmpdir(), "relay-folder-"));
  const folder = join(dir, unique("Album"));
  await mkdir(join(folder, "inner"), { recursive: true });
  await writeFile(join(folder, "one.txt"), "1");
  await writeFile(join(folder, "inner", "two.txt"), "2");
  await page.getByTestId("folder-input").setInputFiles(folder);
  await fileInput(page).setInputFiles([textFile(unique("loose") + ".txt")]);
  const rows = selected(page).getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Folder · 2 files");
  // A folder hides how much it holds, so the summary counts every file.
  await expect(composer(page).locator(".composer-summary")).toHaveText(/^1 folder and 1 file · 3 files in all · /);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
});

test("repeated identical files and folders are saved as separate paths", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Directory inputs are only automatable in Chromium");
  const dir = await mkdtemp(join(tmpdir(), "relay-repeat-picks-"));
  const filePath = join(dir, "same.txt");
  const folder = join(dir, unique("Repeated"));
  await writeFile(filePath, "same loose file");
  await mkdir(join(folder, "inner"), { recursive: true });
  await writeFile(join(folder, "one.txt"), "one");
  await writeFile(join(folder, "inner", "two.txt"), "two");

  await fileInput(page).setInputFiles(filePath);
  await fileInput(page).setInputFiles(filePath);
  await page.getByTestId("folder-input").setInputFiles(folder);
  await page.getByTestId("folder-input").setInputFiles(folder);
  await writeText(page, "one note for the whole repeated selection");
  await composer(page).getByRole("button", { name: "Show files", exact: true }).click();

  const rows = selected(page).getByRole("listitem");
  await expect(rows).toHaveCount(4);
  await expect(selected(page)).toContainText("same (2).txt");
  await expect(selected(page)).toContainText(`${folder.split(/[\\/]/).pop()} (2)`);

  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  const response = await page.request.get(`/api/items?q=${encodeURIComponent(folder.split(/[\\/]/).pop()!)}`);
  const pageOfItems = await response.json();
  const item = pageOfItems.items[0];
  expect(item).toMatchObject({ files: 6, folders: 4, texts: 1, uploading: false });
  const detail = await (await page.request.get(`/api/items/${item.id}`)).json();
  expect(
    detail.nodes
      .filter((node: { kind: string }) => node.kind === "file")
      .map((node: { path: string }) => node.path)
      .sort(),
  ).toEqual(
    [
      "same.txt",
      "same (2).txt",
      `${folder.split(/[\\/]/).pop()}/one.txt`,
      `${folder.split(/[\\/]/).pop()}/inner/two.txt`,
      `${folder.split(/[\\/]/).pop()} (2)/one.txt`,
      `${folder.split(/[\\/]/).pop()} (2)/inner/two.txt`,
    ].sort(),
  );
  expect(detail.nodes.find((node: { kind: string }) => node.kind === "text")?.text).toBe(
    "one note for the whole repeated selection",
  );
  for (const node of detail.nodes.filter((node: { kind: string }) => node.kind === "file")) {
    const content = await page.request.get(urls.nodeContent(node.id));
    expect(content.ok()).toBe(true);
    const expected = node.path.endsWith("/one.txt")
      ? "one"
      : node.path.endsWith("/two.txt")
        ? "two"
        : "same loose file";
    expect(await content.text()).toBe(expected);
  }
});

test("uploads can be cancelled and nothing half-finished is kept", async ({ page }) => {
  // Hold every upload chunk so the transfer stays in progress.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/uploads/**", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await held;
    await route.abort().catch(() => {});
  });
  const name = unique("cancelme");
  await fileInput(page).setInputFiles([
    { name: `${name}.bin`, mimeType: "application/octet-stream", buffer: Buffer.alloc(3 * 1024 * 1024, 1) },
  ]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  const card = page.locator(".transfer").first();
  await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card).toContainText("Cancelled");
  await expect.poll(async () => (await (await page.request.get(`/api/items?q=${name}`)).json()).items.length).toBe(0);
  release();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("typed text is kept when the tab reloads, and is gone once sent", async ({ page }) => {
  await signedIn(page);
  const text = unique("kept text");
  await writeText(page, text);
  await page.reload();
  const box = page.locator("#composer-text");
  await expect(box).toHaveValue(text);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await page.reload();
  await composer(page).getByRole("group", { name: "Content type" }).getByRole("button", { name: "Text" }).click();
  await expect(box).toHaveValue("");
});

test("closing or reloading a tab abandons its uploads; nothing offers to resume", async ({ page }) => {
  // Hold the upload's data in the browser so it is unfinished when the tab reloads.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/uploads/**", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await held;
    await route.abort().catch(() => {});
  });
  const name = unique("abandon");
  await fileInput(page).setInputFiles([
    { name: `${name}.bin`, mimeType: "application/octet-stream", buffer: Buffer.alloc(2 * 1024 * 1024, 2) },
  ]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first().getByRole("button", { name: "Cancel" })).toBeVisible();
  // Keep the PATCH held while the tab reloads. Removing the route here would
  // release it at once, and a file that fully arrives before the reload is
  // legitimately saved.
  page.on("dialog", (d) => void d.accept());
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await expect(page.locator(".transfer")).toHaveCount(0);
  await expect(page.getByText(/unfinished|resume/i)).toHaveCount(0);
  await expect
    .poll(async () => (await (await page.request.get(`/api/items?q=${name}`)).json()).items.length, { timeout: 20_000 })
    .toBe(0);
  release();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a finished transfer stays in the drop box until Done; there is no separate transfers list", async ({ page }) => {
  const name = unique("inbox");
  await fileInput(page).setInputFiles([textFile(name + ".txt", "hello")]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  const box = composer(page);
  await expect(box.locator(".transfer")).toContainText("Saved to Files");
  await expect(page.getByRole("heading", { name: "Transfers" })).toHaveCount(0);
  // Completed actions leave the destination panel while the result is shown.
  await expect(destinations(page).getByRole("button", { name: "Save to Files" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Recent" })).toContainText(name);
  await box.getByRole("button", { name: "Done" }).click();
  await expect(box.locator(".transfer")).toHaveCount(0);
  await expect(box.getByText(/Drop files or folders|Choose files to send/)).toBeVisible();
  // Dropping or picking something new while a result is shown also starts the next one.
  await fileInput(page).setInputFiles([textFile(unique("again") + ".txt", "x")]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(box.locator(".transfer")).toContainText("Saved to Files");
  await fileInput(page).setInputFiles([textFile(unique("next") + ".txt", "y")]);
  await expect(box.locator(".transfer")).toHaveCount(0);
  await expect(selected(page).getByRole("listitem")).toHaveCount(1);
});

test("a running transfer can shrink to a strip while you compose the next one", async ({ page, browserName }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/uploads/**", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await held;
    await route.abort().catch(() => {});
  });
  const name = unique("strip");
  await fileInput(page).setInputFiles([
    {
      name: name + ".bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(1024 * 1024, 3),
    },
  ]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  const box = composer(page);
  await expect(box.locator(".transfer").getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(box.getByRole("button", { name: "Done" })).toHaveCount(0);
  await box.getByRole("button", { name: "Send something else" }).click();
  const strip = box.getByRole("list", { name: "Other transfers" }).getByRole("group");
  await expect(strip).toContainText(name);
  await expect(box.getByText(/Drop files or folders|Choose files to send/)).toBeVisible();
  // Pasting text anywhere on the page lands in the one message box. Firefox drops the
  // clipboard data of synthetic paste events, so this check runs in the other engines.
  if (browserName !== "firefox") {
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "pasted note");
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    });
    await expect(page.locator("#composer-text")).toHaveValue("pasted note");
  }
  await strip.getByRole("button", { name: "Cancel" }).click();
  await expect(strip).toContainText("Cancelled");
  await strip.getByRole("button", { name: /Dismiss/ }).click();
  await expect(box.getByRole("list", { name: "Other transfers" })).toHaveCount(0);
  release();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("clearing typed text can be undone", async ({ page }) => {
  await writeText(page, "a note worth keeping");
  await composer(page).getByRole("button", { name: "Clear" }).click();
  await expect(page.locator("#composer-text")).toHaveValue("");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator("#composer-text")).toHaveValue("a note worth keeping");
});
