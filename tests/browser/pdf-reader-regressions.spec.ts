import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { destinations, fileInput, signedIn } from "./helpers";
import { mixedPdf, readingPdf } from "./pdf-fixtures";

async function fixture(name: string) {
  return {
    name,
    mimeType: "application/pdf",
    buffer: await readFile(new URL(`./fixtures/pdf-review/${name}`, import.meta.url)),
  };
}

async function save(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await fileInput(page).setInputFiles(file);
  await destinations(page).getByRole("button", { name: "Save to Files", exact: true }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await page.getByRole("link", { name: "Files", exact: true }).click();
  const card = page
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: new RegExp(file.name) })
    .first();
  await card.click();
  return card;
}

// Reuse the authorized device cookie to avoid login-rate-limit waits. Every test
// still receives a fresh browser context, including an independent module registry.
const reader = (page: Page) => page.locator(".pdf-reader");
async function ready(page: Page, text: string) {
  await expect(reader(page).locator(".textLayer")).toContainText(text);
  await expect(reader(page).locator(".pdf-reader-loading")).toHaveCount(0);
}

for (const name of ["cjk-cmap.pdf", "jpx-image.pdf", "ccitt-scan.pdf"]) {
  test(`matching PDF.js resources preserve ${name} content`, async ({ page }) => {
    await signedIn(page, "PDF reader review");
    const resources: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/assets/pdfjs-")) resources.push(request.url());
    });
    await save(page, await fixture(name));
    const canvas = reader(page).locator("canvas");
    await expect(canvas).toHaveCount(1);
    await expect(reader(page).locator(".pdf-reader-loading")).toHaveCount(0);
    await expect(reader(page).getByRole("alert")).toHaveCount(0);
    const pixels = await canvas.evaluate((canvas: HTMLCanvasElement) => {
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonwhite = 0,
        red = 0,
        green = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) nonwhite++;
        if (data[i] > 180 && data[i + 1] < 80 && data[i + 2] < 80) red++;
        if (data[i] < 80 && data[i + 1] > 90 && data[i + 2] < 80) green++;
      }
      return { nonwhite, red, green };
    });
    if (name === "cjk-cmap.pdf") {
      await expect(reader(page).locator(".textLayer")).toContainText("中文测试：文档阅读与搜索");
      expect(resources.some((url) => url.endsWith(".bcmap"))).toBe(true);
      await reader(page).getByRole("searchbox", { name: "Find in PDF" }).fill("文档阅读");
      await expect(reader(page).locator(".pdf-reader-search [role=status]")).toHaveText("1 of 1 matches");
    } else {
      expect(pixels.nonwhite, "valid scanned content must be drawn").toBeGreaterThan(10_000);
      expect(
        resources.some((url) =>
          url.endsWith(name === "jpx-image.pdf" ? "openjpeg_nowasm_fallback.js" : "jbig2_nowasm_fallback.js"),
        ),
      ).toBe(true);
      if (name === "jpx-image.pdf") {
        expect(pixels.red).toBeGreaterThan(1000);
        expect(pixels.green).toBeGreaterThan(1000);
      }
    }
    await test
      .info()
      .attach("rendered-content", { body: JSON.stringify({ pixels, resources }), contentType: "application/json" });
    await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  });
}

for (const name of ["cjk-cmap.pdf", "jpx-image.pdf", "ccitt-scan.pdf"]) {
  test(`failed PDF resources show an error and retry restores ${name}`, async ({ page, context }) => {
    await signedIn(page, "PDF reader review");
    const assets = "**/assets/pdfjs-*/**";
    await context.route(assets, (route) => route.fulfill({ status: 503, body: "Synthetic resource unavailable" }));
    await save(page, await fixture(name));
    await expect(reader(page).getByRole("alert")).toContainText("couldn’t be loaded");
    await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
    await context.unroute(assets);
    await reader(page).getByRole("button", { name: "Try again" }).click();
    await expect(reader(page).locator("canvas")).toHaveCount(1);
    await expect(reader(page).locator(".pdf-reader-loading")).toHaveCount(0);
    await expect(reader(page).getByRole("alert")).toHaveCount(0);
    if (name === "cjk-cmap.pdf") await expect(reader(page).locator(".textLayer")).toContainText("中文测试");
    else
      expect(
        await reader(page)
          .locator("canvas")
          .evaluate((canvas: HTMLCanvasElement) => {
            const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
            let nonwhite = 0;
            for (let i = 0; i < data.length; i += 4)
              if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) nonwhite++;
            return nonwhite;
          }),
        "retry must restore scanned content",
      ).toBeGreaterThan(10_000);
  });
}

test("Fit width follows the independently reproduced embedded-font rotation", async ({ page }) => {
  await signedIn(page, "PDF reader review");
  await save(page, await fixture("embedded-rotated.pdf"));
  await ready(page, "Rotation fixture page 1");
  await reader(page).getByRole("button", { name: "Next page", exact: true }).click();
  await ready(page, "Rotation fixture page 2");
  await expect
    .poll(() =>
      reader(page)
        .getByRole("document")
        .evaluate((container) => ({
          stage: container.clientWidth,
          paper: container.querySelector<HTMLElement>(".page")!.clientWidth,
        }))
        .then(({ stage, paper }) => paper - stage),
    )
    .toBeLessThanOrEqual(1);
  await expect(reader(page).getByRole("combobox", { name: "Fit PDF" })).toHaveValue("page-width");
});

test("a failed PDF reader chunk retries and reopens without reloading Relay", async ({ page, context }) => {
  await signedIn(page, "PDF reader review");
  const chunk = /\/assets\/PdfReader-[^/]+\.js(?:\?.*)?$/;
  await page.route(chunk, (route) => route.abort());
  const card = await save(page, readingPdf("reader-chunk.pdf"));
  const failure = page.getByRole("heading", { name: "This page couldn’t load" });
  await expect(failure).toBeVisible();
  // Retry must also remain usable if the network is still unavailable.
  await page.getByRole("button", { name: "Try again" }).click();
  await card.click();
  await expect(failure).toBeVisible();
  await page.unroute(chunk);
  await page.evaluate(() => ((window as unknown as { kept: boolean }).kept = true));
  await page.getByRole("button", { name: "Try again" }).click();
  await card.click();
  await ready(page, "Invoice page 1 END");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("list", { name: "Files" })
    .getByRole("button", { name: /reader-chunk/ })
    .first()
    .click();
  await ready(page, "Invoice page 1 END");
  expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
  expect(context.pages()).toHaveLength(1);
});

test("fit follows actual rotated and mixed page sizes while custom zoom is preserved", async ({ page }) => {
  await signedIn(page, "PDF reader review");
  await save(page, mixedPdf());
  const input = reader(page).getByRole("spinbutton", { name: "PDF page" });
  const stage = reader(page).locator(".pdf-reader-scroll");
  const paper = reader(page).locator(".page");
  for (const number of [1, 2, 3, 4, 2, 1]) {
    await input.fill(String(number));
    await input.press("Enter");
    await ready(page, `Mixed page ${number}`);
    await expect(reader(page).getByRole("combobox", { name: "Fit PDF" })).toHaveValue("page-width");
    await expect
      .poll(async () => (await paper.boundingBox())!.width - (await stage.boundingBox())!.width)
      .toBeLessThanOrEqual(1);
  }
  await reader(page).getByRole("combobox", { name: "Fit PDF" }).selectOption("page-fit");
  await input.fill("4");
  await input.press("Enter");
  await ready(page, "Mixed page 4");
  await expect
    .poll(async () => (await paper.boundingBox())!.height - (await stage.boundingBox())!.height)
    .toBeLessThanOrEqual(1);
  await reader(page).getByRole("button", { name: "Zoom in", exact: true }).click();
  const zoom = await reader(page).getByLabel("PDF zoom").innerText();
  await input.fill("2");
  await input.press("Enter");
  await ready(page, "Mixed page 2");
  await expect(reader(page).getByLabel("PDF zoom")).toHaveText(zoom);
  await expect(reader(page).getByRole("combobox", { name: "Fit PDF" })).toHaveValue("");
});

test("tagged headings and paragraphs remain semantic after rendering and zoom", async ({ page, browserName }) => {
  await signedIn(page, "PDF reader review");
  await save(page, await fixture("tagged.pdf"));
  await ready(page, "Tagged heading fixture");
  const document = reader(page).getByRole("document");
  await expect.poll(() => document.ariaSnapshot()).toContain('heading "Tagged heading fixture" [level=1]');
  await expect.poll(() => document.ariaSnapshot()).toContain("paragraph: Accessible paragraph in reading order");
  const line = reader(page).locator(".textLayer").getByText("Tagged heading fixture", { exact: true });
  const bounds = (await line.boundingBox())!;
  await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toContain("Tagged heading fixture");
  async function nativeSemantics() {
    if (browserName !== "chromium") return;
    const session = await page.context().newCDPSession(page);
    await session.send("Accessibility.enable");
    type AXNode = { nodeId: string; role?: { value: string }; name?: { value: string }; childIds?: string[] };
    const tree = (await session.send("Accessibility.getFullAXTree")) as { nodes: AXNode[] };
    const nodes = new Map(tree.nodes.map((node) => [node.nodeId, node]));
    const text = (id: string): string => {
      const node = nodes.get(id);
      return `${node?.name?.value || ""} ${(node?.childIds || []).map(text).join(" ")}`;
    };
    expect(
      tree.nodes.some((node) => node.role?.value === "heading" && node.name?.value === "Tagged heading fixture"),
    ).toBe(true);
    expect(
      tree.nodes.some(
        (node) =>
          node.role?.value === "paragraph" && text(node.nodeId).includes("Accessible paragraph in reading order"),
      ),
    ).toBe(true);
    await test
      .info()
      .attach("native-tagged-semantics", { body: JSON.stringify(tree), contentType: "application/json" });
    await session.detach();
  }
  // Playwright's DOM-based ARIA snapshot alone misses Chromium's display:contents
  // ownership failure: the actual browser AX tree must carry the tagged text too.
  await nativeSemantics();
  await reader(page).getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(() => document.ariaSnapshot()).toContain('heading "Tagged heading fixture" [level=1]');
  await expect.poll(() => document.ariaSnapshot()).toContain("paragraph: Accessible paragraph in reading order");
  await nativeSemantics();
});

test("clearing PDF search stays clear after PDF.js finishes its close event", async ({ page }) => {
  await signedIn(page, "PDF reader review");
  await save(page, readingPdf("reader-search-clear.pdf"));
  await ready(page, "Invoice page 1 END");
  const search = reader(page).getByRole("searchbox", { name: "Find in PDF" });
  await search.fill("page 2 END");
  await ready(page, "Invoice page 2 END");
  const status = reader(page).locator(".pdf-reader-search [role=status]");
  await expect(status).toHaveText("1 of 1 matches");
  await search.fill("");
  await expect(reader(page).locator(".textLayer .highlight")).toHaveCount(0);
  // Let the asynchronous findbarclose callback and React update finish.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(status).toBeEmpty();
  await search.fill("absent invoice");
  await expect(status).toHaveText("No matches");
  await search.fill("");
  await page.keyboard.press("Tab");
  await expect(status).toBeEmpty();
});
