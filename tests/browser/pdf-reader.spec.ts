import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { copyShareUrl, destinations, fileInput, signedIn } from "./helpers";

import { readingPdf } from "./pdf-fixtures";

const reader = (page: Page) => page.locator(".pdf-reader");
async function save(page: Page, name: string, count = 3, padding = 0, link = false) {
  await fileInput(page).setInputFiles([readingPdf(name, count, padding)]);
  await destinations(page)
    .getByRole("button", { name: link ? "Create link" : "Save to Files", exact: true })
    .click();
  const transfer = page.locator(".transfer").first();
  await expect(transfer).toContainText(link ? "Link ready" : "Saved to Files");
  const share = link ? await copyShareUrl(transfer) : "";
  await page.getByRole("link", { name: "Files", exact: true }).click();
  const card = page
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: new RegExp(name) })
    .first();
  const baseline = await page.evaluate(() => window.pdfReaderProbe?.());
  await card.click();
  return { card, share, baseline };
}
async function ready(page: Page, number = 1) {
  await expect(reader(page).locator(".textLayer")).toContainText(`Invoice page ${number} END`);
  await expect(
    reader(page)
      .getByRole("status")
      .filter({ hasText: /^Loading/ }),
  ).toHaveCount(0);
}

declare global {
  interface Window {
    pdfReaderProbe: () => { pixels: number; count: number; largest: number; workers: number };
  }
}

// Retain even detached page canvases to test their backing budget and explicit release.
// PDF.js also uses tiny text-measurement canvases; those are GC-owned, rather than page cache.
async function probe(page: Page) {
  await page.addInitScript(() => {
    const canvases: HTMLCanvasElement[] = [];
    const workers: Worker[] = [];
    const stopped = new Set<Worker>();
    const create = document.createElement.bind(document);
    document.createElement = (tag: string, options?: ElementCreationOptions) => {
      const element = create(tag, options);
      if (tag.toLowerCase() === "canvas") canvases.push(element as HTMLCanvasElement);
      return element;
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the original canvas as this below.
    const clone = HTMLCanvasElement.prototype.cloneNode;
    HTMLCanvasElement.prototype.cloneNode = function (deep = false) {
      const canvas = clone.call(this, deep) as HTMLCanvasElement;
      canvases.push(canvas);
      return canvas;
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        workers.push(this);
      }
      terminate() {
        stopped.add(this);
        super.terminate();
      }
    };
    window.pdfReaderProbe = () => {
      const pages = canvases.filter((canvas) => canvas.getAttribute("role") === "presentation");
      return {
        pixels: pages.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
        count: pages.filter((canvas) => canvas.width * canvas.height > 1).length,
        largest: Math.max(0, ...pages.map((canvas) => canvas.width * canvas.height)),
        workers: workers.length - stopped.size,
      };
    };
  });
}
async function stats(page: Page) {
  return page.evaluate(() => window.pdfReaderProbe());
}

test("PDF reading stays in Relay with selectable text, page controls, find, zoom and accessible labels", async ({
  page,
  context,
}) => {
  await signedIn(page, "PDF controls");
  const { card } = await save(page, "reader-controls.pdf");
  await ready(page);
  await expect(page.getByRole("button", { name: "Open original in a new tab" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Original|Open PDF/ })).toHaveCount(0);
  const canvas = reader(page).locator("canvas").first();
  expect(await canvas.evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(1);
  // The maintained text layer supplies text to selection and the accessibility tree.
  const snapshot = await reader(page).getByRole("document").ariaSnapshot();
  expect(snapshot).toContain("Invoice page 1 END");
  expect(
    await reader(page)
      .locator(".textLayer")
      .evaluate((layer) => {
        const range = document.createRange();
        range.selectNodeContents(layer);
        const selection = getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return selection.toString();
      }),
  ).toContain("Invoice page 1 END");
  const before = await reader(page).getByLabel("PDF zoom").innerText();
  await reader(page).getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(reader(page).getByLabel("PDF zoom")).not.toHaveText(before);
  await reader(page).getByRole("combobox", { name: "Fit PDF" }).selectOption("page-fit");
  await reader(page).getByRole("button", { name: "Next page", exact: true }).click();
  await ready(page, 2);
  await reader(page).getByRole("searchbox", { name: "Find in PDF" }).fill("page 3 END");
  await ready(page, 3);
  await expect(
    reader(page)
      .getByRole("status")
      .filter({ hasText: /1 of 1 matches/ }),
  ).toBeVisible();
  await reader(page).getByRole("searchbox", { name: "Find in PDF" }).fill("missing invoice");
  await expect(reader(page).getByRole("status").filter({ hasText: "No matches" })).toBeVisible();
  const violations = await new AxeBuilder({ page })
    .include(".pdf-reader")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(violations.violations).toEqual([]);
  await reader(page).getByRole("document").focus();
  await page.keyboard.press("Control+f");
  await expect(reader(page).getByRole("searchbox", { name: "Find in PDF" })).toBeFocused();
  // Tab wraps inside the dialog. Reader arrows never switch to another file.
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    expect(await page.getByRole("dialog").evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  }
  await reader(page).getByRole("document").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(card).toBeFocused();
  expect(context.pages()).toHaveLength(1);
});

test("ordinary shared PDFs read inside Relay and Back and download remain available", async ({ page, browser }) => {
  await signedIn(page, "PDF share");
  const { share } = await save(page, "reader-shared.pdf", 3, 0, true);
  const visitor = await browser.newContext();
  try {
    const guest = await visitor.newPage();
    await guest.goto(share);
    await ready(guest);
    const top = guest.url();
    await reader(guest).getByRole("button", { name: "Next page", exact: true }).click();
    await ready(guest, 2);
    expect(guest.url()).toBe(top);
    const [download] = await Promise.all([
      guest.waitForEvent("download"),
      guest.getByRole("button", { name: "Download", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("reader-shared.pdf");
    expect(visitor.pages()).toHaveLength(1);
  } finally {
    await visitor.close();
  }
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("PDF failures are actionable and retry starts a fresh reader", async ({ page }) => {
  await signedIn(page, "PDF retry");
  await page.route("**/api/nodes/*/content?inline=1", (route) =>
    route.fulfill({ status: 503, body: "Synthetic file unavailable" }),
  );
  await save(page, "reader-retry.pdf");
  await expect(reader(page).getByRole("alert")).toContainText("couldn’t be loaded");
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await page.unroute("**/api/nodes/*/content?inline=1");
  await reader(page).getByRole("button", { name: "Try again" }).click();
  await ready(page);
  // A corrupt PDF gets the same usable retry/close path, rather than a silent canvas.
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.route("**/api/nodes/*/content?inline=1", (route) =>
    route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4\ninvalid" }),
  );
  await page
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: /reader-retry/ })
    .first()
    .click();
  await expect(reader(page).getByRole("alert")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reader(page)).toHaveCount(0);
});

test("large PDF uses ranges, reaches pages beyond 300 and keeps cached canvas backing bounded", async ({ page }) => {
  test.setTimeout(180_000);
  await probe(page);
  await signedIn(page, "PDF bounds");
  const ranges: { range: string | undefined; status: number }[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/content?inline=1"))
      ranges.push({ range: response.request().headers().range, status: response.status() });
  });
  const { baseline } = await save(page, "reader-large.pdf", 310, 32 * 1024);
  await ready(page);
  expect(ranges.some((request) => request.range && request.status === 206)).toBe(true);
  const pageInput = reader(page).getByRole("spinbutton", { name: "PDF page" });
  for (const number of [12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 310, 1]) {
    await pageInput.fill(String(number));
    await pageInput.press("Enter");
    await ready(page, number);
    const measured = await stats(page);
    expect(measured.largest).toBeLessThanOrEqual(2_000_000);
    expect(measured.pixels).toBeLessThanOrEqual(20_000_000);
  }
  // Match selection can occur after the last count event in a long document.
  await reader(page).getByRole("searchbox", { name: "Find in PDF" }).fill("page 42 END");
  await ready(page, 42);
  await expect(reader(page).getByRole("status").filter({ hasText: "1 of 1 matches" })).toBeVisible();
  await reader(page).getByRole("searchbox", { name: "Find in PDF" }).fill("");
  await pageInput.fill("1");
  await pageInput.press("Enter");
  await ready(page);
  // The same backing budget applies at high zoom and tall viewports, including cached pages.
  await page.setViewportSize({ width: 1200, height: 6000 });
  await reader(page).getByRole("combobox", { name: "Fit PDF" }).selectOption("page-width");
  for (let i = 0; i < 6; i++) await reader(page).getByRole("button", { name: "Zoom in", exact: true }).click();
  await ready(page);
  expect((await stats(page)).largest).toBeLessThanOrEqual(2_000_000);
  expect((await stats(page)).pixels).toBeLessThanOrEqual(20_000_000);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(async () => (await stats(page)).workers).toBe(baseline.workers);
  await expect.poll(async () => (await stats(page)).pixels).toBe(baseline.pixels);
});

test("closing or switching during a delayed PDF load cancels its worker and restores the right file", async ({
  page,
}) => {
  await probe(page);
  await signedIn(page, "PDF cancel");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/nodes/*/content?inline=1", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await fileInput(page).setInputFiles([readingPdf("reader-first.pdf"), readingPdf("reader-second.pdf")]);
  await destinations(page).getByRole("button", { name: "Save to Files", exact: true }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await page
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: /reader-first/ })
    .first()
    .click();
  const baseline = await stats(page);
  await page.locator(".tile-open").filter({ hasText: "reader-first.pdf" }).click();
  await expect(reader(page).getByRole("status").filter({ hasText: "Loading PDF" })).toBeVisible();
  await page.getByRole("button", { name: "Next file", exact: true }).click();
  await expect(page.getByRole("dialog").last().getByRole("heading")).toHaveText("reader-second.pdf");
  await page.getByRole("dialog").last().getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(async () => (await stats(page)).workers).toBe(baseline.workers);
  release();
  await page.unrouteAll({ behavior: "wait" });
  await page.locator(".tile-open").filter({ hasText: "reader-second.pdf" }).click();
  await ready(page);
  await reader(page).getByRole("document").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("dialog").last().getByRole("heading")).toHaveText("reader-second.pdf");
  await page.getByRole("dialog").last().getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(async () => (await stats(page)).workers).toBe(baseline.workers);
});

test("a stalled PDF worker is released on close and produces a bounded retryable startup error", async ({ page }) => {
  await probe(page);
  await signedIn(page, "PDF worker timeout");
  await fileInput(page).setInputFiles(readingPdf("reader-worker.pdf"));
  await destinations(page).getByRole("button", { name: "Save to Files", exact: true }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await page.getByRole("link", { name: "Files", exact: true }).click();
  const baseline = await stats(page);
  await page.route("**/pdf.worker*.mjs", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "/* Deliberately stalled synthetic worker. */" }),
  );
  const card = page
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: /reader-worker/ })
    .first();
  await card.click();
  await expect.poll(async () => (await stats(page)).workers).toBe(baseline.workers + 1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(async () => (await stats(page)).workers).toBe(baseline.workers);
  await page.clock.install();
  await card.click();
  await expect.poll(async () => (await stats(page)).workers).toBe(baseline.workers + 1);
  await page.clock.fastForward(60_001);
  await expect(reader(page).getByRole("alert")).toBeVisible();
  await expect.poll(async () => (await stats(page)).workers).toBe(baseline.workers);
  await page.unroute("**/pdf.worker*.mjs");
  await reader(page).getByRole("button", { name: "Try again" }).click();
  await page.clock.resume();
  await ready(page);
});
