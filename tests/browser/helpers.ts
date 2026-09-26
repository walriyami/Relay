import { expect, request, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { api } from "../../shared/api.ts";

export const BASE = `http://localhost:${process.env.RELAY_TEST_PORT || 3091}`;
const PASSWORD = "Browser-test-password-only";

type State = Awaited<ReturnType<Awaited<ReturnType<typeof request.newContext>>["storageState"]>>;
// Sign-ins are rate limited, so each named device signs in once per worker and
// later tests reuse its cookies. Different names are different devices.
const states = new Map<string, State>();
export async function deviceState(name: string) {
  let state = states.get(name);
  if (state) return state;
  const context = await request.newContext({ baseURL: BASE });
  for (let attempt = 0; ; attempt++) {
    const response = await context.post(api.session.password.path, {
      data: { username: "admin", password: PASSWORD, deviceName: name },
    });
    if (response.ok()) break;
    if (response.status() !== 429 || attempt > 6) throw new Error(`Login failed: ${response.status()}`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  state = await context.storageState();
  await context.dispose();
  states.set(name, state);
  return state;
}

export async function signedIn(page: Page, device = "Laptop") {
  await page.context().addCookies((await deviceState(device)).cookies);
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
}

export async function deviceContext(
  browser: Browser,
  device: string,
  options: Parameters<Browser["newContext"]>[0] = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...options, baseURL: BASE, storageState: await deviceState(device) });
  const page = await context.newPage();
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  return { context, page };
}

export const unique = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Read the URL from the actual Copy link action without relying on browser clipboard permissions. */
export async function copyShareUrl(scope: Page | Locator, label = "Copy link") {
  const copy = scope.getByRole("button", { name: label, exact: true });
  await copy.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          (window as Window & { relayTestCopied?: string }).relayTestCopied = value;
          return Promise.resolve();
        },
      },
    });
  });
  await copy.click();
  const url = await scope
    .locator(".share-access")
    .evaluate(() => (window as Window & { relayTestCopied?: string }).relayTestCopied);
  expect(url).toMatch(/^https?:\/\//);
  return url!;
}

export async function png(width = 1200, height = 900, color = { r: 40, g: 120, b: 220 }) {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

export function textFile(name: string, text = "hello from relay\n") {
  return { name, mimeType: "text/plain", buffer: Buffer.from(text) };
}

// Records every write request the page makes, so tests can prove nothing was uploaded.
export function recordWrites(page: Page) {
  const writes: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "GET" || req.method() === "HEAD") return;
    writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });
  return writes;
}

export const composer = (page: Page) => page.getByRole("region", { name: "Compose" });
export const destinations = (page: Page) => page.getByRole("complementary", { name: "Send to" });
export const fileInput = (page: Page) => page.getByTestId("file-input");
export const selected = (page: Page) => page.getByRole("list", { name: "Selected items" });

// The composer shows files or text; switch to Text, then type.
export async function writeText(page: Page, text: string) {
  await composer(page).getByRole("group", { name: "Content type" }).getByRole("button", { name: "Text" }).click();
  await page.locator("#composer-text").fill(text);
}

/** A valid PDF with `pages` blank pages, built by hand so tests need no fixture files. */
export function pdf(name: string, pages = 2) {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>");
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { name, mimeType: "application/pdf", buffer: Buffer.from(body, "latin1") };
}
