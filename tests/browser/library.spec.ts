import { test, expect, type Page } from "@playwright/test";
import {
  composer,
  deviceContext,
  fileInput,
  pdf,
  png,
  signedIn,
  textFile,
  unique,
  destinations,
  writeText,
} from "./helpers";

async function saveShare(page: Page, name: string) {
  await fileInput(page).setInputFiles([
    { name: `${name}.png`, mimeType: "image/png", buffer: await png(2400, 1600) },
    textFile(`${name}-notes.txt`, "line one\nline two\n"),
  ]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test("recent items open in a popup at their own address; Back closes it and stays on Send", async ({ page }) => {
  const name = unique("recent");
  await saveShare(page, name);
  const recent = page.getByRole("list", { name: "Recent" });
  await recent
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The popup has its own address, so it can be reloaded or shared; Back returns to Send.
  await expect(page).toHaveURL(/\/files\/[0-9a-f-]{36}$/);
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Send", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(composer(page)).toBeVisible();
});

test("opening a collection's address loads each view once, not again when the live stream opens", async ({ page }) => {
  const name = unique("once");
  await saveShare(page, name);
  await page
    .getByRole("list", { name: "Recent" })
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  await expect(page).toHaveURL(/\/files\/[0-9a-f-]{36}$/);
  const address = new URL(page.url());
  const loads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.startsWith("/api/")) loads.push(url.pathname);
  });
  const stream = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/events");
  await page.goto(address.pathname);
  await expect(page.getByRole("dialog")).toContainText(`${name}-notes.txt`);
  await stream;
  // Long enough for the stream's catch-up, which waits out the views' one-second refresh spacing.
  await page.waitForTimeout(2000);
  const count = (path: string) => loads.filter((loaded) => loaded === path).length;
  expect(count(`/api${address.pathname.replace("/files/", "/items/")}`)).toBe(1);
  expect(count("/api/items")).toBe(1);
  expect(count("/api/activity")).toBe(1);
});

test("Escape closes the top popup only, then the next one", async ({ page }) => {
  const name = unique("nested");
  await saveShare(page, name);
  await page
    .getByRole("list", { name: "Recent" })
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  const collection = page.getByRole("dialog");
  await collection.locator(".tile-open", { hasText: `${name}-notes.txt` }).click();
  await expect(page.getByRole("dialog")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "Files" }).click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
});

test("files show as compact square cards that fill the row", async ({ page, isMobile }) => {
  for (let i = 0; i < 3; i++) await saveShare(page, unique("grid"));
  await page.getByRole("link", { name: "Files" }).click();
  const cards = page.getByRole("list", { name: "Files" }).locator(".card");
  await expect(cards.nth(2)).toBeVisible();
  const boxes = await Promise.all([0, 1, 2, 3].map((i) => cards.nth(i).locator(".card-media").boundingBox()));
  for (const box of boxes.slice(0, 3)) {
    expect(Math.abs(box!.width - box!.height)).toBeLessThan(2);
    expect(box!.width).toBeLessThan(240);
  }
  if (!isMobile) {
    expect(Math.abs(boxes[0]!.y - boxes[3]!.y)).toBeLessThan(2);
  }
});

test("Recent reports a failed load with a retry instead of showing an empty state", async ({ page }) => {
  let fail = true;
  await page.route("**/api/items?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("limit") === "12" && !params.has("offset") && fail) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary list failure" }),
      });
    }
    return route.continue();
  });
  await page.reload();
  const recent = page.locator('section[aria-labelledby="recent-title"]');
  await expect(recent.getByRole("heading", { name: "Recent files couldn’t be loaded" })).toBeVisible();
  await expect(recent.getByRole("button", { name: "Retry" })).toBeVisible();
  fail = false;
  await recent.getByRole("button", { name: "Retry" }).click();
  await expect(recent.getByRole("heading", { name: "Recent files couldn’t be loaded" })).toHaveCount(0);
});

test("library selection is page-local, bulk actions are confirmed, and Trash supports search and restore", async ({
  page,
}) => {
  const group = unique("bulk-library");
  const firstName = `${group}-one.txt`;
  const secondName = `${group}-two.txt`;
  for (const name of [firstName, secondName]) {
    await fileInput(page).setInputFiles([textFile(name, `contents of ${name}`)]);
    await destinations(page).getByRole("button", { name: "Save to Files" }).click();
    await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  }
  const firstResponse = await page.request.get(`/api/items?q=${encodeURIComponent(firstName)}&limit=200`);
  const secondResponse = await page.request.get(`/api/items?q=${encodeURIComponent(secondName)}&limit=200`);
  const firstItem = (await firstResponse.json()).items[0];
  const secondItem = (await secondResponse.json()).items[0];
  expect(firstItem).toBeTruthy();
  expect(secondItem).toBeTruthy();

  // Return two real items on the first page and one on the second. The contract says 201 total so
  // the UI exposes page navigation without creating hundreds of test uploads.
  await page.route("**/api/items?*", async (route) => {
    if (!page.url().match(/\/files(?:\?|$)/)) return route.continue();
    const params = new URL(route.request().url()).searchParams;
    if (!params.has("offset")) return route.continue();
    const offset = Number(params.get("offset"));
    const q = (params.get("q") ?? "").toLowerCase();
    if (q) {
      const matches = [firstItem, secondItem].filter((item) => item.name.toLowerCase().includes(q));
      return route.fulfill({ json: { items: matches, total: matches.length } });
    }
    return route.fulfill({
      json: { items: offset === 0 ? [firstItem, secondItem] : [secondItem], total: 201 },
    });
  });

  await page.getByRole("link", { name: "Files" }).click();
  const files = page.getByRole("list", { name: "Files" });
  await expect(files.getByRole("listitem")).toHaveCount(2);
  // Choosing is a mode: cards carry no checkboxes until Select is on, and then a click picks one.
  await expect(files.getByRole("checkbox")).toHaveCount(0);
  const toolbar = page.locator(".toolbar");
  const bar = page.getByRole("toolbar", { name: "Selected items" });
  const cardOf = (name: string) => files.locator(`.card-open[aria-label^="${name}."]`);
  await toolbar.getByRole("button", { name: "Select", exact: true }).click();
  await expect(bar).toContainText("Choose items");
  await expect(files.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
  await cardOf(firstItem.name).click();
  await expect(cardOf(firstItem.name)).toHaveAttribute("aria-pressed", "true");
  await expect(bar).toContainText("1 selected");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator(".list-more [role=status]")).toContainText("Page 2 of 2");
  await expect(page.locator(".library-results .card-open").first()).toBeFocused();
  await expect(cardOf(secondItem.name)).toHaveAttribute("aria-pressed", "false");
  await expect(bar).toContainText("Choose items");
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.locator(".library-results .card-open").first()).toBeFocused();
  await expect(cardOf(firstItem.name)).toHaveAttribute("aria-pressed", "false");

  // One step per action: choosing how long to keep them applies it and ends choosing.
  await bar.getByRole("button", { name: "Select all" }).click();
  await expect(bar).toContainText("2 selected");
  await bar.getByRole("button", { name: "Move 2 items to Trash after" }).click();
  const retentionStarted = Date.now();
  const retentionResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/items/bulk") && response.request().method() === "POST",
  );
  await page.getByRole("menu").getByRole("menuitem", { name: "7 days" }).click();
  const saved = await retentionResponse;
  const retentionFinished = Date.now();
  expect(saved.ok()).toBe(true);
  expect(await saved.json()).toEqual({ updated: 2 });
  await expect(
    page.getByText("Retention saved for 2 items. Each item’s saved deadline is shown in its details."),
  ).toBeVisible();
  // Each saved deadline respects its own hard expiry, which bulk retention cannot extend.
  for (const item of [firstItem, secondItem]) {
    const response = await page.request.get(`/api/items/${item.id}`);
    expect(response.ok()).toBe(true);
    const retained = await response.json();
    expect(retained.hardExpires).toBe(item.hardExpires);
    expect(retained.expires).toBeGreaterThanOrEqual(
      Math.min(retentionStarted + 7 * 86_400_000, item.hardExpires ?? Infinity),
    );
    expect(retained.expires).toBeLessThanOrEqual(
      Math.min(retentionFinished + 7 * 86_400_000, item.hardExpires ?? Infinity),
    );
  }
  await expect(bar).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "Select", exact: true })).toBeVisible();

  // Escape leaves choosing without doing anything.
  await toolbar.getByRole("button", { name: "Select", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);

  await toolbar.getByRole("button", { name: "Select", exact: true }).click();
  await bar.getByRole("button", { name: "Select all" }).click();
  await bar.getByRole("button", { name: "Move to Trash" }).click();
  const confirm = page.getByRole("dialog", { name: "Move 2 items to Trash?" });
  await expect(confirm).toContainText("their links will stop working");
  await confirm.getByRole("button", { name: "Move to Trash" }).click();
  await expect(page.getByText("2 items moved to Trash")).toBeVisible();

  await page.unroute("**/api/items?*");
  await page.locator(".page-head").getByRole("button", { name: "Trash" }).click();
  const trashSearch = page.getByRole("searchbox", { name: "Search Trash" });
  await trashSearch.fill(group);
  const trash = page.getByRole("list", { name: "Trash" });
  await expect(trash.getByRole("listitem")).toHaveCount(2);
  await page.getByLabel("Sort").selectOption("name");
  await expect(trash.getByRole("listitem")).toHaveCount(2);
  await page.locator(".toolbar").getByRole("button", { name: "Select", exact: true }).click();
  const trashBar = page.getByRole("toolbar", { name: "Selected items" });
  await trashBar.getByRole("button", { name: "Select all" }).click();
  await trashBar.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("2 items restored")).toBeVisible();
  await expect(trash.getByRole("listitem")).toHaveCount(0);
});

test("cards say what's inside and have a quick actions menu", async ({ page }) => {
  const name = unique("mixed");
  await fileInput(page).setInputFiles([
    { name: `${name}.png`, mimeType: "image/png", buffer: await png(400, 300) },
    { name: `${name}-b.png`, mimeType: "image/png", buffer: await png(400, 300, { r: 200, g: 60, b: 40 }) },
  ]);
  await writeText(page, "caption for the photos");
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText(`${name}.png + 1 more + text`);
  const card = page.getByRole("list", { name: "Recent" }).locator(".collection-card", { hasText: name }).first();
  await expect(card.locator(".card-title")).toHaveText(`${name}.png + 1 more + text`);
  await expect(card).toContainText("2 files and text");
  await expect(card.locator(".mosaic .thumb")).toHaveCount(2);
  await card.getByRole("button", { name: /Actions for/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Open",
    "Download ZIP",
    "Copy text",
    "Share",
    "Rename…",
    "Add files…",
    "Move to Trash after…",
    "Move to Trash",
  ]);
  await menu.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
  await expect(page.getByRole("list", { name: "Recent" }).locator(".collection-card", { hasText: name })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("list", { name: "Recent" }).locator(".collection-card", { hasText: name })).toHaveCount(
    1,
  );
});

test("image previews use small server thumbnails, never the original file", async ({ page }) => {
  const name = unique("thumb");
  const originals: string[] = [];
  const thumbs: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (/\/thumbnail/.test(url)) thumbs.push(url);
    // Whole-file reads have no Range header; previews must only ever read a range.
    else if (/\/api\/nodes\/[^/]+\/content/.test(url) && !req.headers()["range"]) originals.push(url);
  });
  await saveShare(page, name);
  await page.getByRole("link", { name: "Files" }).click();
  await page
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(`img`).first()).toBeVisible();
  await expect.poll(() => thumbs.length).toBeGreaterThan(0);
  // Text previews read only a small range, never the whole file through a normal download.
  await page.waitForTimeout(1000);
  expect(originals).toEqual([]);
  const thumb = await page.request.get(thumbs[0]);
  expect(thumb.ok()).toBe(true);
  expect(Number(thumb.headers()["content-length"] || (await thumb.body()).length)).toBeLessThan(200_000);
});

test("unsupported types show an icon instead of a preview", async ({ page }) => {
  const name = unique("blob");
  await fileInput(page).setInputFiles([
    { name: `${name}.zzz`, mimeType: "application/octet-stream", buffer: Buffer.alloc(1000, 3) },
  ]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  const card = page
    .getByRole("list", { name: "Recent" })
    .getByRole("button", { name: new RegExp(name) })
    .first();
  await expect(card.locator(".thumb-icon")).toBeVisible();
  await expect(card.locator("img")).toHaveCount(0);
});

test("ZIP downloads stream straight away, with nothing prepared first", async ({ page }) => {
  const name = unique("zip");
  await saveShare(page, name);
  const writes: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "GET" && req.method() !== "HEAD")
      writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });
  const card = page.getByRole("list", { name: "Recent" }).locator(".collection-card", { hasText: name }).first();
  await card.getByRole("button", { name: /Actions for/ }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menu").getByRole("menuitem", { name: "Download ZIP" }).click();
  expect(new URL((await download).url()).pathname).toMatch(/^\/api\/items\/[^/]+\/zip$/);
  expect(writes).toEqual([]);
  await expect(page.getByText(/Preparing ZIP/)).toHaveCount(0);
});

test("an item can be renamed and added to, but what is in it can't be changed", async ({ page }) => {
  const name = unique("immutable");
  await saveShare(page, name);
  const recent = page.getByRole("list", { name: "Recent" });
  await recent
    .locator(".collection-card", { hasText: name })
    .first()
    .getByRole("button", { name: /Actions for/ })
    .click();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: /Move to…|New folder/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await recent
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  let item = page.getByRole("dialog", { name: `${name}.png + 1 more` });
  await expect(item.getByRole("button", { name: /New folder|Rename|Move/ })).toHaveCount(0);
  // Each file offers what can be done with it: open it, or download it. Files keep their names.
  await expect(item.getByRole("button", { name: `Download ${name}-notes.txt` })).toBeVisible();
  await expect(item.getByRole("button", { name: `Actions for ${name}-notes.txt` })).toHaveCount(0);

  // The footer holds the item's actions; the rarer ones are under More.
  const moreButton = () => item.locator(".modal-foot").getByRole("button", { name: "More actions" });
  await expect(item.locator(".modal-foot").getByRole("button")).toHaveText(["More", "Share", "Download ZIP"]);
  await moreButton().click();
  const more = page.getByRole("menu");
  await expect(more.getByRole("menuitem")).toHaveText([
    "Rename…",
    "Add files…",
    "Move to Trash after…",
    "Move to Trash",
  ]);
  // Clicking anywhere else closes the menu, and the window stays open.
  await item.locator(".modal-body").click({ position: { x: 4, y: 4 } });
  await expect(more).toHaveCount(0);
  await expect(item).toBeVisible();

  // The item as a whole takes a name; emptying it goes back to one taken from what's inside.
  await moreButton().click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const rename = page.getByRole("dialog", { name: "Rename" });
  await expect(rename.getByLabel("Name")).toHaveValue("");
  await rename.getByLabel("Name").fill(`${name} trip`);
  await rename.getByRole("button", { name: "Rename" }).click();
  item = page.getByRole("dialog", { name: `${name} trip` });
  await expect(item).toBeVisible();
  await expect(moreButton()).toBeFocused();

  // A forgotten file joins it rather than needing a second link.
  await moreButton().click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Add files…" }).click();
  await (await chooser).setFiles([textFile(`${name}-forgotten.txt`, "almost left behind")]);
  await expect(page.getByText(`Added 1 file to “${name} trip”`)).toBeVisible();
  await expect(item.getByRole("button", { name: `Download ${name}-forgotten.txt` })).toBeVisible();
  await expect(item.getByRole("button", { name: `Download ${name}-notes.txt` })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(recent.locator(".collection-card", { hasText: `${name} trip` }).first()).toContainText("3 files");
});

test("a single photo fills the item window and zooms to full size", async ({ page }) => {
  const name = unique("photo");
  await fileInput(page).setInputFiles([{ name: `${name}.png`, mimeType: "image/png", buffer: await png(2400, 1600) }]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await page
    .getByRole("list", { name: "Recent" })
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  const item = page.getByRole("dialog", { name: `${name}.png` });
  const stage = item.getByRole("region", { name: `Preview of ${name}.png` });
  const image = stage.locator("img");
  await expect(image).toBeVisible();
  await expect(item.locator(".modal-foot").getByRole("button", { name: "Download" })).toBeVisible();

  // Large: the preview takes most of a tall window, and the photo fills it edge to edge one way.
  const viewport = page.viewportSize()!;
  const win = (await item.boundingBox())!;
  const area = (await stage.boundingBox())!;
  const img = (await image.boundingBox())!;
  expect(win.height).toBeGreaterThan(Math.min(640, viewport.height - 48) - 2);
  expect(area.height).toBeGreaterThan(win.height * 0.5);
  expect(img.width >= area.width - 32 || img.height >= area.height - 32).toBe(true);

  const zoom = stage.getByRole("button", { name: "Show at full size" });
  await zoom.click();
  await expect(stage.getByRole("button", { name: "Fit to window" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(img.width * 1.5);
  await stage.getByRole("button", { name: "Fit to window" }).click();
  await expect(stage.getByRole("button", { name: "Show at full size" })).toBeVisible();
});

test("request creation retries an id conflict once with the complete form and a fresh id", async ({ page }) => {
  const name = unique("request-retry");
  const bodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/requests", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (bodies.length === 1)
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "That request id is already in use." }),
      });
    return route.continue();
  });
  await page.getByRole("link", { name: "Requests" }).click();
  await page.getByRole("button", { name: "New request" }).click();
  await page.getByLabel("What are you asking for?").fill(name);
  await page.getByLabel("Message (optional)").fill("Please include the originals.");
  await page.getByRole("radio", { name: "1 day" }).click();
  await page.getByRole("button", { name: "Change" }).click();
  await page.getByLabel("Total size limit (GB)").fill("2.5");
  await page.getByRole("button", { name: "Create request" }).click();
  await expect(page.getByRole("dialog").getByRole("img", { name: "QR code for this upload request" })).toBeVisible();

  expect(bodies).toHaveLength(2);
  expect(bodies[0].id).not.toBe(bodies[1].id);
  const withoutId = (body: Record<string, unknown>) => {
    const { id: _id, ...form } = body;
    return form;
  };
  expect(withoutId(bodies[1])).toEqual(withoutId(bodies[0]));
});

test("request retry after a lost response uses a new id when the form changes", async ({ page }) => {
  const name = unique("request-edit-retry");
  const bodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/requests", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (bodies.length === 1) {
      const committed = await route.fetch();
      expect(committed.ok()).toBe(true);
      return route.abort("failed");
    }
    return route.continue();
  });
  await page.getByRole("link", { name: "Requests" }).click();
  await page.getByRole("button", { name: "New request" }).click();
  await page.getByLabel("What are you asking for?").fill(name);
  await page.getByRole("button", { name: "Create request" }).click();
  await expect(page.getByRole("alert")).toContainText("Relay couldn’t be reached");
  await page.getByLabel("Message (optional)").fill("Updated after the first attempt.");
  await page.getByRole("button", { name: "Create request" }).click();
  await expect(page.getByRole("dialog").getByRole("img", { name: "QR code for this upload request" })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0].id).not.toBe(bodies[1].id);
  expect(bodies[1].description).toBe("Updated after the first attempt.");
});

test("sending to a device reports an offline conflict and refreshes devices", async ({ page, browser }) => {
  const phone = await deviceContext(browser, "Phone");
  try {
    const name = unique("delivery-offline");
    await writeText(page, name);
    const created = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/transfers",
    );
    await destinations(page).getByRole("button", { name: "Save to Files" }).click();
    const response = await created;
    expect(response.ok()).toBe(true);
    const { itemId } = await response.json();
    await expect(page.locator(".transfer").first()).toContainText("Saved to Files");

    let deviceReads = 0;
    page.on("request", (request) => {
      if (request.method() === "GET" && new URL(request.url()).pathname === "/api/devices") deviceReads++;
    });
    await page.route("**/api/deliveries", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "That device is not online." }),
      });
    });
    const before = deviceReads;
    // Open the exact item created above; text-only cards of equal length share a visible name.
    await page.goto(`/files/${itemId}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("region", { name: "Text" })).toContainText(name);
    await dialog.getByRole("button", { name: "More actions" }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: `Send to ${phone.name}`, exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("That device is not online.");
    await expect.poll(() => deviceReads).toBeGreaterThan(before);
    await phone.context.close();
    await dialog.getByRole("button", { name: "More actions" }).click();
    await expect(
      page.getByRole("menu").getByRole("menuitem", { name: `Send to ${phone.name}`, exact: true }),
    ).toHaveCount(0);
  } finally {
    await phone.context.close().catch(() => {});
  }
});

test("request id conflicts retry only once and leave a useful error", async ({ page }) => {
  const ids: string[] = [];
  await page.route("**/api/requests", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    ids.push(route.request().postDataJSON().id);
    await route.fulfill({ status: 409, json: { error: "That request id is already in use." } });
  });
  await page.getByRole("link", { name: "Requests" }).click();
  await page.getByRole("button", { name: "New request" }).click();
  await page.getByLabel("What are you asking for?").fill(unique("conflict-limit"));
  await page.getByRole("button", { name: "Create request" }).click();
  await expect(page.getByRole("alert")).toHaveText("That request id is already in use.");
  await expect(page.getByRole("button", { name: "Create request" })).toBeEnabled();
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
});

test("a popup's address survives a reload, and Back then stays on Files", async ({ page }) => {
  const name = unique("deeplink");
  await saveShare(page, name);
  await page.getByRole("link", { name: "Files" }).click();
  await page
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  await expect(page).toHaveURL(/\/files\/[0-9a-f-]{36}$/);
  const address = page.url();
  // Any number of reloads keep it, because the address stays the popup's while it is open.
  for (let i = 0; i < 2; i++) {
    await page.reload();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveURL(address);
  }
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
  // The reloads added no dead steps: the next Back leaves Files for Send.
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);

  // A mistyped address says so instead of silently showing Files.
  await page.goto("/files/not-an-item");
  await expect(page.getByText("That address doesn’t point to anything in Files.")).toBeVisible();
  await expect(page).toHaveURL(/\/files$/);
});

test("the Files search is kept in the address across reload and Back", async ({ page }) => {
  const name = unique("findme");
  await saveShare(page, name);
  await page.getByRole("link", { name: "Files" }).click();
  await page.getByLabel("Search files").fill(name);
  await expect(page).toHaveURL(new RegExp(`/files\\?q=${name}$`));
  await page.reload();
  await expect(page.getByLabel("Search files")).toHaveValue(name);
  await expect(page.getByRole("list", { name: "Files" }).locator(".card")).toHaveCount(1);
  await page.getByLabel("Search files").fill("");
  await expect(page).toHaveURL(/\/files$/);
});

test("PDFs preview page by page inside the app", async ({ page }) => {
  const name = unique("pages");
  await fileInput(page).setInputFiles([pdf(`${name}.pdf`, 3)]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await page.getByRole("link", { name: "Files" }).click();
  await page
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  const viewer = dialog.getByRole("document", { name: `${name}.pdf, 3 pages` });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("img", { name: "Page 1" })).toBeVisible();
  // Canvases start with no backing storage until their queued render completes.
  await expect(viewer.getByRole("img", { name: "Page 1" })).toHaveAttribute("data-rendered", "true");
  expect(
    await viewer
      .locator("canvas")
      .first()
      .evaluate((c: HTMLCanvasElement) => c.width),
  ).toBeGreaterThan(1);
});

test("Back closes one popup at a time, the address follows, and a reload adds no dead Back step", async ({ page }) => {
  const name = unique("layers");
  await saveShare(page, name);
  await page.getByRole("link", { name: "Files" }).click();
  await page
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  await expect(page).toHaveURL(/\/files\/[0-9a-f-]{36}$/);
  const address = page.url();
  await page
    .getByRole("dialog")
    .locator(".tile-open", { hasText: `${name}-notes.txt` })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(2);
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page).toHaveURL(address);
  await page.reload();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(address);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/files$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test("focus moves to the next card when the focused one goes to Trash", async ({ page }) => {
  const first = unique("focus-a");
  const second = unique("focus-b");
  for (const name of [first, second]) {
    await fileInput(page).setInputFiles([textFile(`${name}.txt`)]);
    await destinations(page).getByRole("button", { name: "Save to Files" }).click();
    await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
    // Done, pressed from the keyboard, hands focus back to the drop box rather than dropping it.
    await page.getByRole("button", { name: "Done" }).press("Enter");
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".composer"))).toBe(true);
  }
  await page.getByRole("link", { name: "Files" }).click();
  const list = page.getByRole("list", { name: "Files" });
  const card = list.locator(".collection-card", { hasText: second });
  await card.getByRole("button", { name: /Actions for/ }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menu").getByRole("menuitem", { name: "Move to Trash", exact: true }).press("Enter");
  await expect(card).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest(".collection-card")?.textContent ?? ""))
    .toContain(first);
});
