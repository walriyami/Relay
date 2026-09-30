import { test, expect } from "@playwright/test";
import { api, urls } from "../../shared/api.ts";
import type { ItemDetail, Me, TransferCreated, TransferResult } from "../../shared/model.ts";
import { signedIn, BASE } from "./helpers.ts";

test("uploaded HTML and SVG remain inert in owner and public browser documents", async ({ page, browser }) => {
  await signedIn(page, "Security audit browser");
  const me: Me = await (await page.request.get(api.session.get.path)).json();
  const data = Buffer.from(
    '<script>window.__relayBrowserAudit=1</script><img src=x onerror="window.__relayBrowserAudit=2">',
  );
  const createdResponse = await page.request.post(api.transfers.create.path, {
    headers: { "X-Relay-CSRF": me.csrf },
    data: {
      id: crypto.randomUUID(),
      tab: crypto.randomUUID().replaceAll("-", ""),
      name: null,
      folders: [],
      files: [
        { path: "audit.html", size: data.length, mime: "text/html" },
        { path: "audit.svg", size: data.length, mime: "image/svg+xml" },
      ],
    },
  });
  expect(createdResponse.status()).toBe(200);
  const created: TransferCreated = await createdResponse.json();
  for (const upload of created.uploads) {
    const res = await page.request.patch(urls.upload(upload.id), {
      headers: {
        "X-Relay-CSRF": me.csrf,
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": "0",
        "Content-Type": "application/offset+octet-stream",
      },
      data,
    });
    expect(res.status()).toBe(204);
  }
  const complete = await page.request.post(`/api/transfers/${created.id}/complete`, {
    headers: { "X-Relay-CSRF": me.csrf },
    data: { destination: { kind: "link", days: 1 } },
  });
  expect(complete.status()).toBe(200);
  const result: TransferResult = await complete.json();
  const detail: ItemDetail = await (await page.request.get(`/api/items/${result.itemId}`)).json();
  const visitor = await browser.newContext({ baseURL: BASE });
  const guest = await visitor.newPage();
  try {
    for (const node of detail.nodes) {
      for (const [document, path] of [
        [page, urls.nodeContent(node.id, { inline: true })],
        [guest, urls.shareContent(result.link!.token, node.id, { inline: true })],
      ] as const) {
        const response = await document.goto(`${BASE}${path}`);
        expect(response?.status()).toBe(200);
        const headers = await response!.allHeaders();
        expect(headers["content-type"]).toMatch(/^text\/plain/);
        expect(headers["content-security-policy"]).toMatch(/^sandbox;/);
        expect(headers["x-content-type-options"]).toBe("nosniff");
        await expect(document.locator("body")).toContainText(data.toString());
        expect(
          await document.evaluate(() => (window as Window & { __relayBrowserAudit?: number }).__relayBrowserAudit),
        ).toBeUndefined();
      }
    }
  } finally {
    await visitor.close();
  }
});

test("the built web server does not publish repository files, data or private bytes", async ({ request }) => {
  for (const path of [
    "/.env",
    "/server/config.ts",
    "/package.json",
    "/.data/relay.sqlite",
    "/../.env",
    "/%2e%2e/.env",
  ]) {
    const response = await request.get(path);
    expect([200, 400, 403, 404]).toContain(response.status());
    if (response.status() === 200) {
      expect(response.headers()["content-type"]).toMatch(/^text\/html/);
      expect(await response.text()).toContain('<div id="root">');
    }
  }
  for (const path of ["/assets/audit-missing.js", "/local/audit-missing", "/api/items", "/api/admin"])
    expect((await request.get(path)).status()).toBe(path.startsWith("/api/") ? 401 : 404);
  const page = await request.get("/");
  expect(page.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(page.headers()["referrer-policy"]).toBe("no-referrer");
  expect(page.headers()["x-frame-options"]).toBe("DENY");
});
