import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";

declare global {
  interface Window {
    codeCreationProbe: { creates: number; revoked: string[]; release?: () => void };
    resourceStats: {
      loading: number;
      maxLoading: number;
      rendering: number;
      maxRendering: number;
      overlap: number;
      cleanups: number;
      cleanupDuringRender: number;
      documents: number;
      destroyed: number;
      workers: number;
      workersDestroyed: number;
      cancels: number;
    };
    canvasProbe: { canvases: HTMLCanvasElement[]; maxPixels: number; maxCount: number };
    workersProbe: { created: number; terminated: number };
    setTestHidden: (hidden: boolean) => void;
    releasePdfStage?: () => void;
    holdPdfRender?: boolean;
  }
}
const fixture = "/tests/resources/index.html";

// Real text and vector drawing on every page gives reentry a visible, page-specific result.
function longPdf(pages = 300, width = 612, height = 792) {
  const font = 3 + pages * 2;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`,
  ];
  for (let i = 0; i < pages; i++) {
    const stream =
      `0.2 0.4 0.8 rg 0 ${(height - Math.min(height, 60)) / 2} ${width} ${Math.min(height, 60)} re f\nBT /F1 18 Tf 30 750 Td (Page ${i + 1}) Tj /F1 12 Tf ` +
      Array.from({ length: 18 }, (_, line) => `0 -18 Td (Document line ${line + 1}, page ${i + 1}) Tj`).join(" ") +
      " ET\n";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

async function monitorCanvases(page: Page) {
  await page.addInitScript(() => {
    const probe = (window.canvasProbe = { canvases: [] as HTMLCanvasElement[], maxPixels: 0, maxCount: 0 });
    for (const key of ["width", "height"] as const) {
      const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, key)!;
      Object.defineProperty(HTMLCanvasElement.prototype, key, {
        ...original,
        set(this: HTMLCanvasElement, value: number) {
          original.set!.call(this, value);
          // Count the viewer's output surfaces; pdf.js may also use transient internal canvases.
          if (this.parentElement?.classList.contains("preview-pdf-page") && !probe.canvases.includes(this))
            probe.canvases.push(this);
          const allocated = probe.canvases.filter((canvas) => canvas.width && canvas.height);
          probe.maxCount = Math.max(probe.maxCount, allocated.length);
          probe.maxPixels = Math.max(
            probe.maxPixels,
            allocated.reduce((n, canvas) => n + canvas.width * canvas.height, 0),
          );
        },
      });
    }
    const Original = window.Worker;
    const workers = (window.workersProbe = { created: 0, terminated: 0 });
    window.Worker = class extends Original {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        workers.created++;
      }
      terminate() {
        workers.terminated++;
        super.terminate();
      }
    };
  });
}

async function goToPage(page: Page, number: number) {
  const box = page.locator(`.preview-pdf-page[data-page="${number}"]`);
  await box.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(box.locator("canvas")).toHaveAttribute("data-rendered", "true");
}

async function pixels(page: Page) {
  return page.evaluate(() => window.canvasProbe.canvases.reduce((n, canvas) => n + canvas.width * canvas.height, 0));
}

test("real 300-page PDF retains a bounded canvas window through traversal, resize, reopen and thumbnails", async ({
  page,
}) => {
  const document = longPdf();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await monitorCanvases(page);
  await page.route("**/fixture.pdf", (route) => route.fulfill({ contentType: "application/pdf", body: document }));
  await page.goto(fixture);
  await goToPage(page, 1);
  // Every page is visited, including the final page; reverse passes verify released pages restore.
  for (let number = 2; number <= 300; number++) await goToPage(page, number);
  for (const number of [250, 150, 20, 1, 300, 1]) await goToPage(page, number);
  const before = await page
    .locator('canvas[aria-label="Page 1"]')
    .evaluate((canvas) => (canvas as HTMLCanvasElement).width);
  await page.setViewportSize({ width: 600, height: 800 });
  await expect
    .poll(() => page.locator('canvas[aria-label="Page 1"]').evaluate((canvas) => (canvas as HTMLCanvasElement).width))
    .toBeLessThan(before);
  await goToPage(page, 1);
  expect(
    await page.locator('canvas[aria-label="Page 1"]').evaluate((node) => {
      const canvas = node as HTMLCanvasElement;
      const pixel = canvas
        .getContext("2d")!
        .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      return [...pixel];
    }),
  ).toEqual([51, 102, 204, 255]);
  const budget = await page.evaluate(() => ({
    pixels: window.canvasProbe.maxPixels,
    count: window.canvasProbe.maxCount,
  }));
  expect(budget.pixels).toBeLessThanOrEqual(12_000_000);
  expect(budget.count).toBeLessThanOrEqual(6);
  await page.getByRole("button", { name: "Toggle", exact: true }).click();
  await expect.poll(() => pixels(page)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.workersProbe.terminated)).toBe(1);
  await page.getByRole("button", { name: "Thumbnail", exact: true }).click();
  await expect(page.getByAltText("PDF thumbnail")).toBeVisible();
  await page.getByRole("button", { name: "Toggle", exact: true }).click();
  await goToPage(page, 300);
  await page.getByRole("button", { name: "Toggle", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.workersProbe.terminated)).toBe(2);
  await page.getByRole("button", { name: "Thumbnail", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Thumbnails finished: 2");
  expect(await page.evaluate(() => window.workersProbe.created)).toBe(3);
  expect(errors).toEqual([]);
});

test("all visible short wide PDF pages render within the shared pixel budget", async ({ page }) => {
  await monitorCanvases(page);
  await page.route("**/fixture.pdf", (route) =>
    route.fulfill({ contentType: "application/pdf", body: longPdf(300, 600, 200) }),
  );
  await page.goto(fixture);
  const visiblePages = () =>
    page.evaluate(() => {
      const root = document.querySelector('.preview-pdf[role="document"]');
      if (!root) return [];
      const bounds = root.getBoundingClientRect();
      return Array.from(root.querySelectorAll<HTMLElement>(".preview-pdf-page"))
        .filter((box) => {
          const rect = box.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        })
        .map((box) => {
          const canvas = box.querySelector("canvas")!;
          const color = canvas.width
            ? [
                ...canvas
                  .getContext("2d")!
                  .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data,
              ]
            : [];
          return { number: Number(box.dataset.page), ready: canvas.dataset.rendered === "true", color };
        });
    });
  const checkVisible = async () => {
    await expect.poll(async () => (await visiblePages()).length).toBeGreaterThan(0);
    await expect
      .poll(async () => (await visiblePages()).every((box) => box.ready && box.color.join() === "51,102,204,255"))
      .toBe(true);
  };
  await checkVisible();
  expect((await visiblePages())[0].number).toBe(1);
  for (const number of [150, 300, 1]) {
    await goToPage(page, number);
    await checkVisible();
  }
  await page.setViewportSize({ width: 600, height: 1100 });
  await checkVisible();
  // Taller short/wide pages challenge the same allocation with fewer render jobs.
  // The thin-strip/high-cardinality case remains separate below.
  await page.setViewportSize({ width: 1200, height: 6000 });
  const geometry = await page.evaluate(() => {
    const root = document.querySelector('.preview-pdf[role="document"]')!;
    const bounds = root.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const boxes = Array.from(root.querySelectorAll<HTMLElement>(".preview-pdf-page")).filter((box) => {
      const rect = box.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    // Independent fixture geometry: each 600x200-point page at CSS width and DPR,
    // before the renderer shares or caps its output allocation.
    return {
      visible: boxes.length,
      uncappedPixels: boxes.reduce((sum, box) => {
        const width = Math.floor(box.clientWidth * dpr);
        return sum + width * Math.floor(box.clientWidth * dpr * (200 / 600));
      }, 0),
    };
  });
  expect(geometry.visible).toBeGreaterThan(6);
  expect(geometry.uncappedPixels).toBeGreaterThan(12_000_000);
  await test
    .info()
    .attach("shared-pixel-geometry.json", { body: JSON.stringify(geometry), contentType: "application/json" });
  await checkVisible();
  await test.info().attach("allocation-peaks.json", {
    body: JSON.stringify(
      await page.evaluate(() => ({ maxCount: window.canvasProbe.maxCount, maxPixels: window.canvasProbe.maxPixels })),
    ),
    contentType: "application/json",
  });
  expect(await page.evaluate(() => window.canvasProbe.maxCount)).toBeGreaterThan(6);
  expect(await page.evaluate(() => window.canvasProbe.maxPixels)).toBeGreaterThan(10_000_000);
  expect(await page.evaluate(() => window.canvasProbe.maxPixels)).toBeLessThanOrEqual(12_000_000);
  await page.getByRole("button", { name: "Toggle", exact: true }).click();
  await expect.poll(() => pixels(page)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.workersProbe.terminated)).toBe(1);
});

test("extreme short wide PDF allocation progresses, cancels and completes within a bounded run", async ({ page }) => {
  await monitorCanvases(page);
  await page.route("**/fixture.pdf", (route) =>
    route.fulfill({ contentType: "application/pdf", body: longPdf(300, 600, 20) }),
  );
  await page.goto(fixture);
  const visiblePages = () =>
    page.evaluate(() => {
      const root = document.querySelector('.preview-pdf[role="document"]');
      if (!root) return [];
      const bounds = root.getBoundingClientRect();
      return Array.from(root.querySelectorAll<HTMLElement>(".preview-pdf-page"))
        .filter((box) => {
          const rect = box.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        })
        .map((box) => {
          const canvas = box.querySelector("canvas")!;
          const color = canvas.width
            ? [...canvas.getContext("2d")!.getImageData(Math.floor(canvas.width / 2), 0, 1, 1).data]
            : [];
          return { number: Number(box.dataset.page), ready: canvas.dataset.rendered === "true", color };
        });
    });
  const checkVisible = async () => {
    await expect.poll(async () => (await visiblePages()).length).toBeGreaterThan(6);
    await expect
      .poll(async () => (await visiblePages()).every((box) => box.ready && box.color.join() === "51,102,204,255"))
      .toBe(true);
  };
  await checkVisible();
  expect((await visiblePages())[0].number).toBe(1);
  for (const number of [150, 300, 1]) {
    await goToPage(page, number);
    await checkVisible();
  }
  await page.setViewportSize({ width: 600, height: 1100 });
  await checkVisible();
  // Enough visible pages at DPR 2 to exceed 12M pixels without the shared allocation.
  await page.setViewportSize({ width: 1200, height: 6000 });
  const began = Date.now();
  const progress: { elapsedMs: number; visible: number; ready: number }[] = [];
  const snapshot = async () => {
    const boxes = await visiblePages();
    const result = {
      elapsedMs: Date.now() - began,
      visible: boxes.length,
      ready: boxes.filter((box) => box.ready).length,
    };
    progress.push(result);
    return result;
  };
  try {
    // Preserve the original extreme geometry; exact count depends on layout/browser.
    await expect.poll(async () => (await snapshot()).visible).toBeGreaterThan(100);
    await expect.poll(async () => (await snapshot()).ready).toBeGreaterThan(0);
    const beforeClose = await snapshot();
    expect(beforeClose.ready).toBeLessThan(beforeClose.visible);
    await page.getByRole("button", { name: "Toggle", exact: true }).click();
    await expect.poll(() => pixels(page)).toBe(0);
    await expect.poll(() => page.evaluate(() => window.workersProbe.terminated)).toBe(1);
    const afterClose = await page.evaluate(() => ({
      pixels: window.canvasProbe.canvases.reduce((n, canvas) => n + canvas.width * canvas.height, 0),
      workers: window.workersProbe,
    }));
    await test
      .info()
      .attach("extreme-close.json", {
        body: JSON.stringify({ beforeClose, afterClose }),
        contentType: "application/json",
      });
    await page.getByRole("button", { name: "Toggle", exact: true }).click();
    await expect.poll(async () => (await snapshot()).visible).toBeGreaterThan(100);
    let previous = await snapshot();
    // Each progress wait retains the original 12-second expectation timeout.
    // Eventual completion is bounded by the unchanged 180-second test timeout,
    // not asserted to be a 12-second product latency SLA.
    while (previous.ready < previous.visible) {
      await expect.poll(async () => (await snapshot()).ready).toBeGreaterThan(previous.ready);
      previous = await snapshot();
      expect(await page.evaluate(() => window.canvasProbe.maxPixels)).toBeLessThanOrEqual(12_000_000);
    }
    await checkVisible(); // Every visible page still must be ready and exactly colored.
  } finally {
    await test
      .info()
      .attach("extreme-progress.json", { body: JSON.stringify(progress), contentType: "application/json" });
  }
  await test.info().attach("allocation-peaks.json", {
    body: JSON.stringify(
      await page.evaluate(() => ({ maxCount: window.canvasProbe.maxCount, maxPixels: window.canvasProbe.maxPixels })),
    ),
    contentType: "application/json",
  });
  expect(await page.evaluate(() => window.canvasProbe.maxCount)).toBeGreaterThan(6);
  expect(await page.evaluate(() => window.canvasProbe.maxPixels)).toBeGreaterThan(10_000_000);
  expect(await page.evaluate(() => window.canvasProbe.maxPixels)).toBeLessThanOrEqual(12_000_000);
  await page.getByRole("button", { name: "Toggle", exact: true }).click();
  await expect.poll(() => pixels(page)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.workersProbe.terminated)).toBe(2);
});

test("native PDF workers with a stalled handshake terminate on close and document startup timeout", async ({
  page,
}) => {
  await monitorCanvases(page);
  await page.clock.install();
  // Intercept the real native module, preserving Vite's ?url import and the actual PDFWorker.
  await page.route("**/pdf.worker.min.mjs", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "/* Worker never answers pdf.js messages. */" }),
  );
  await page.goto(fixture);
  await expect.poll(() => page.evaluate(() => window.workersProbe.created)).toBe(1);
  await page.getByRole("button", { name: "Toggle", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.workersProbe.terminated)).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.workersProbe.created)).toBe(2);
  await page.clock.runFor(60_001);
  await expect(page.getByRole("alert")).toHaveText("Preview failed");
  expect(await page.evaluate(() => window.workersProbe.terminated)).toBe(2);
  await page.getByRole("button", { name: "Toggle", exact: true }).click();
  expect(await page.evaluate(() => window.workersProbe.terminated)).toBe(2);
});

test("cancellation settles before page reuse and all document/worker resources are released on errors and churn", async ({
  page,
}) => {
  await monitorCanvases(page);
  // Keep the first render in flight until resize cancels it; a timed render can finish
  // before Playwright observes it on a busy browser, leaving this race unexercised.
  await page.addInitScript(() => {
    window.holdPdfRender = true;
  });
  const mock = await readFile(new URL("./pdf-mock.txt", import.meta.url), "utf8");
  await page.route("**/node_modules/.vite/deps/pdfjs-dist.js*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: mock }),
  );
  await page.goto(fixture);
  await expect.poll(() => page.evaluate(() => window.resourceStats?.rendering)).toBeGreaterThan(0);
  await page.evaluate(() => {
    window.holdPdfRender = false;
  });
  await page.setViewportSize({ width: 900, height: 800 });
  await expect.poll(() => page.evaluate(() => window.resourceStats.cancels)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 650, height: 800 });
  for (const number of [1, 70, 150, 300, 1]) await goToPage(page, number);
  await expect.poll(() => page.evaluate(() => window.resourceStats.rendering)).toBe(0);
  let stats = await page.evaluate(() => window.resourceStats);
  expect(stats.maxRendering).toBeLessThanOrEqual(2);
  expect(stats.maxLoading).toBeLessThanOrEqual(2);
  expect(stats.overlap).toBe(0);
  expect(stats.cleanupDuringRender).toBe(0);
  expect(stats.cancels).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.canvasProbe.maxPixels)).toBeLessThanOrEqual(12_000_000);
  expect(await page.evaluate(() => window.canvasProbe.canvases.every((c) => c.width <= 8192 && c.height <= 8192))).toBe(
    true,
  );
  await page.getByRole("button", { name: "Change file" }).click();
  await expect(page.getByRole("alert")).toHaveText("Preview failed");
  await expect.poll(() => page.evaluate(() => window.resourceStats.workersDestroyed)).toBe(2);
  expect((await page.evaluate(() => window.resourceStats)).destroyed).toBe(2);
  await page.evaluate(() => {
    window.holdPdfRender = true;
  });
  await page.getByRole("button", { name: "Change file" }).click();
  await expect.poll(() => page.evaluate(() => window.resourceStats.rendering)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Toggle", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.resourceStats.rendering + window.resourceStats.loading)).toBe(0);
  await expect.poll(() => pixels(page)).toBe(0);
  stats = await page.evaluate(() => window.resourceStats);
  expect(stats.workersDestroyed).toBe(stats.workers);
  expect(stats.destroyed).toBe(stats.documents);
  expect(stats.cleanupDuringRender).toBe(0);
});

test("closing during worker startup, document loading or page loading releases late resolutions", async ({ page }) => {
  const mock = await readFile(new URL("./pdf-mock.txt", import.meta.url), "utf8");
  await page.route("**/node_modules/.vite/deps/pdfjs-dist.js*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: mock }),
  );
  for (const stage of ["worker", "document", "page"]) {
    await page.goto(`${fixture}?stage=${stage}`);
    await expect.poll(() => page.evaluate(() => !!window.releasePdfStage)).toBe(true);
    await page.getByRole("button", { name: "Toggle", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.resourceStats.workersDestroyed)).toBe(1);
    await page.evaluate(() => window.releasePdfStage?.());
    await expect.poll(() => page.evaluate(() => window.resourceStats.loading)).toBe(0);
    const stats = await page.evaluate(() => window.resourceStats);
    expect(stats.rendering).toBe(0);
    expect(stats.destroyed).toBe(stage === "worker" ? 0 : 1);
    expect(stats.cleanups).toBe(stage === "page" ? 1 : 0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
});

async function deviceFixture(page: Page, expiresIn = 300_000) {
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    window.setTestHidden = (next: boolean) => {
      hidden = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
  await page.route("**/api/pickup/config", (route) =>
    route.fulfill({ json: { codeLength: 6, protection: { mode: "open" } } }),
  );
  await page.route("**/api/pickup/current", (route) => route.fulfill({ json: { code: "234-567" } }));
  await page.route("**/api/login-codes", (route) =>
    route.fulfill({ json: { id: "code", code: "234-567", token: "fixture", expiresIn } }),
  );
  await page.route("**/api/login-codes/code", (route) => route.fulfill({ json: { ok: true } }));
}

test("hidden Add Device stops polling and countdown, checks immediately on return, and pauses again after use", async ({
  page,
}) => {
  await deviceFixture(page);
  let state = "pending",
    checks = 0;
  await page.route("**/api/login-codes/code/status", (route) => {
    checks++;
    return route.fulfill({ json: { state, deviceName: "Phone" } });
  });
  await page.goto(`${fixture}?device`);
  await expect(page.getByRole("timer")).toBeVisible();
  await expect.poll(() => checks).toBe(1);
  await page.clock.install();
  await page.evaluate(() => window.setTestHidden(true));
  const countdown = await page.getByRole("timer").textContent();
  await page.clock.runFor(20_000);
  expect(checks).toBe(1);
  expect(await page.getByRole("timer").textContent()).toBe(countdown);
  state = "used";
  await page.evaluate(() => window.setTestHidden(false));
  await expect(page.getByRole("status").filter({ hasText: "Phone is signed in." })).toBeVisible();
  expect(checks).toBe(2);
  await page.clock.runFor(10_000);
  expect(checks).toBe(2);
});

test("hidden expiry reconciles immediately without polling or showing a reusable code; revoked codes end on return", async ({
  page,
}) => {
  await deviceFixture(page, 5000);
  let state = "pending",
    checks = 0;
  await page.route("**/api/login-codes/code/status", (route) => {
    checks++;
    return route.fulfill({ json: { state } });
  });
  await page.goto(`${fixture}?device`);
  await expect(page.getByRole("timer")).toBeVisible();
  await expect.poll(() => checks).toBe(1);
  await page.clock.install();
  await page.evaluate(() => window.setTestHidden(true));
  await page.clock.runFor(10_000);
  await page.evaluate(() => window.setTestHidden(false));
  await expect(page.getByRole("status").filter({ hasText: "This code expired." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy sign-in link" })).toHaveCount(0);
  expect(checks).toBe(1);
  await page.getByRole("button", { name: "Create a new code" }).click();
  await expect.poll(() => checks).toBe(2);
  await page.evaluate(() => window.setTestHidden(true));
  state = "gone";
  await page.clock.runFor(1000);
  await page.evaluate(() => window.setTestHidden(false));
  await expect(page.getByRole("status").filter({ hasText: "This code no longer works." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy sign-in link" })).toHaveCount(0);
  expect(checks).toBe(3);
});

test("returning while a status request is in flight reconciles as soon as it settles", async ({ page }) => {
  await deviceFixture(page);
  let checks = 0;
  let release: (() => void) | undefined;
  await page.route("**/api/login-codes/code/status", async (route) => {
    checks++;
    if (checks === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return route.fulfill({ json: checks === 1 ? { state: "pending" } : { state: "used", deviceName: "Tablet" } });
  });
  await page.goto(`${fixture}?device`);
  await expect(page.getByRole("timer")).toBeVisible();
  await expect.poll(() => checks).toBe(1);
  await page.evaluate(() => window.setTestHidden(true));
  await page.evaluate(() => window.setTestHidden(false));
  expect(checks).toBe(1);
  release!();
  await expect(page.getByRole("status").filter({ hasText: "Tablet is signed in." })).toBeVisible();
  expect(checks).toBe(2);
});

for (const strict of [false, true])
  for (const stage of ["pending", "resolved-before-render"] as const) {
    test(`Add Device withdraws a code closed during creation: ${stage}${strict ? " with effect replay" : ""}`, async ({
      page,
    }) => {
      await page.addInitScript(() => {
        const original = window.fetch.bind(window);
        const state = (window.codeCreationProbe = {
          creates: 0,
          revoked: [] as string[],
          release: undefined as (() => void) | undefined,
        });
        window.fetch = async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input, location.href);
          if (url.pathname === "/api/login-codes" && init?.method === "POST") {
            state.creates++;
            return new Promise<Response>((resolve) => {
              state.release = () =>
                resolve(Response.json({ id: "late-code", code: "234-567", token: "fixture", expiresIn: 300_000 }));
            });
          }
          if (url.pathname === "/api/login-codes/late-code" && init?.method === "DELETE") {
            state.revoked.push("late-code");
            return Response.json({ ok: true });
          }
          return original(input, init);
        };
      });
      await deviceFixture(page);
      await page.goto(`${fixture}?device${strict ? "&strict" : ""}`);
      await expect.poll(() => page.evaluate(() => window.codeCreationProbe.creates)).toBe(1);
      if (stage === "pending") {
        await page.getByRole("button", { name: "Toggle", exact: true }).click();
        await page.evaluate(() => window.codeCreationProbe.release!());
      } else {
        // Let fetch, body decoding, and create's continuation resolve within this same task.
        // React cannot commit the code view before the synchronous close below.
        await page.evaluate(async () => {
          window.codeCreationProbe.release!();
          for (let step = 0; step < 12; step++) await Promise.resolve();
          (document.querySelector("button") as HTMLButtonElement).click();
        });
      }
      await expect(page.locator(".login-code")).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => window.codeCreationProbe.revoked)).toEqual(["late-code"]);
    });
  }

const thumbnailFixture = "/tests/resources/lifetimes.html";
async function startThumbnails(page: Page, documents: Buffer[]) {
  await page.evaluate(
    (documents) => {
      for (const bytes of documents) window.startThumbnail(bytes);
    },
    documents.map((document) => [...document]),
  );
}

async function interceptWorkerMessages(page: Page) {
  await page.addInitScript(() => {
    const Original = window.Worker;
    window.pdfMessages = { documentRequests: 0, terminationRequests: 0 };
    window.Worker = class extends Original {
      postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
        const action = (message as { action?: string }).action;
        if (action === "GetDocRequest") window.pdfMessages.documentRequests++;
        if (action === "Terminate") window.pdfMessages.terminationRequests++;
        if (action === "GetDocRequest" && window.dropPdfDocument) {
          window.dropPdfDocument = false;
          return;
        }
        if (action === "Terminate" && window.dropPdfTerminate) return;
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    };
  });
}

test("thumbnail startup failure terminates the shared native worker and permits a concurrent retry", async ({
  page,
}) => {
  await monitorCanvases(page);
  await page.clock.install();
  await page.route("**/pdf.worker.min.mjs", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "/* Worker never initializes. */",
    }),
  );
  await page.goto(thumbnailFixture);
  await startThumbnails(page, [longPdf(1), longPdf(1)]);
  await expect.poll(() => page.evaluate(() => window.workersProbe.created)).toBe(1);
  await page.clock.runFor(60_010);
  await expect.poll(() => page.evaluate(() => window.thumbnailResults.errors.length)).toBe(2);
  expect(await page.evaluate(() => window.workersProbe.terminated)).toBe(1);
  await page.unroute("**/pdf.worker.min.mjs");
  await startThumbnails(page, [longPdf(1), longPdf(1)]);
  await expect.poll(() => page.evaluate(() => window.thumbnailResults.images.length)).toBe(2);
  expect(await page.evaluate(() => window.workersProbe)).toEqual({ created: 2, terminated: 1 });
});

test("thumbnail document startup is bounded when a real worker loses a document request", async ({ page }) => {
  await monitorCanvases(page);
  await interceptWorkerMessages(page);
  await page.clock.install();
  await page.goto(thumbnailFixture);
  await page.evaluate(() => {
    window.dropPdfDocument = true;
  });
  await startThumbnails(page, [longPdf(1), longPdf(1)]);
  await expect.poll(() => page.evaluate(() => window.thumbnailResults.images.length)).toBe(1);
  await page.clock.runFor(16_010);
  await expect.poll(() => page.evaluate(() => window.thumbnailResults.errors.length)).toBe(1);
  expect(await page.evaluate(() => window.workersProbe)).toEqual({ created: 1, terminated: 1 });
  await startThumbnails(page, [longPdf(1)]);
  await expect.poll(() => page.evaluate(() => window.thumbnailResults.images.length)).toBe(2);
  expect(await page.evaluate(() => window.workersProbe.created)).toBe(2);
});

test("thumbnail cleanup is bounded when a real worker loses termination acknowledgements", async ({ page }) => {
  await monitorCanvases(page);
  await interceptWorkerMessages(page);
  await page.clock.install();
  await page.goto(thumbnailFixture);
  await page.evaluate(() => {
    window.dropPdfTerminate = true;
  });
  await startThumbnails(page, [longPdf(1)]);
  await expect.poll(() => page.evaluate(() => window.workersProbe.created)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.pdfMessages.terminationRequests)).toBe(1);
  await page.clock.runFor(1_010);
  await expect.poll(() => page.evaluate(() => window.thumbnailResults.images.length)).toBe(1);
  expect(await page.evaluate(() => window.workersProbe.terminated)).toBe(1);
  await page.evaluate(() => {
    window.dropPdfTerminate = false;
  });
  await startThumbnails(page, [longPdf(1)]);
  await expect.poll(() => page.evaluate(() => window.thumbnailResults.images.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.workersProbe.created)).toBe(2);
});

test("concurrent valid and invalid thumbnails preserve the healthy shared native worker", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await monitorCanvases(page);
  await page.goto(thumbnailFixture);
  await startThumbnails(page, [longPdf(1), Buffer.from("Not a PDF"), longPdf(2)]);
  await expect.poll(() => page.evaluate(() => window.thumbnailResults.images.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.thumbnailResults.errors.length)).toBe(1);
  await startThumbnails(page, [longPdf(1)]);
  await expect.poll(() => page.evaluate(() => window.thumbnailResults.images.length)).toBe(3);
  expect(await page.evaluate(() => window.workersProbe)).toEqual({ created: 1, terminated: 0 });
  expect(errors).toEqual([]);
});
