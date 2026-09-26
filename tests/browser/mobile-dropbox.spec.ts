import { expect, test, type Locator } from "@playwright/test";
import { destinations, signedIn, writeText } from "./helpers";

async function expectMobileHandoff(result: Locator) {
  const qr = result.getByRole("img", { name: "QR code for this link" });
  const panel = result.locator(".share-access");
  const copyLink = result.getByRole("button", { name: "Copy link" });
  const codeLabel = result.locator(".share-access-code-label");
  const code = result.locator(".share-access-code .code");
  const copyCode = result.getByRole("button", { name: "Copy code" });
  const [titleBox, qrBox, panelBox, linkBox, codeLabelBox, codeBox, copyCodeBox, iconBox] = await Promise.all([
    result.locator(".transfer-hero-name").boundingBox(),
    qr.boundingBox(),
    panel.boundingBox(),
    copyLink.boundingBox(),
    codeLabel.boundingBox(),
    code.boundingBox(),
    copyCode.boundingBox(),
    copyCode.locator("svg").boundingBox(),
  ]);
  expect(titleBox).not.toBeNull();
  expect(qrBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect(linkBox).not.toBeNull();
  expect(codeLabelBox).not.toBeNull();
  expect(codeBox).not.toBeNull();
  expect(copyCodeBox).not.toBeNull();
  expect(iconBox).not.toBeNull();
  expect(qrBox!.width).toBeGreaterThanOrEqual(180);
  expect(titleBox!.y + titleBox!.height).toBeLessThan(qrBox!.y);
  expect(qrBox!.y + qrBox!.height).toBeLessThan(linkBox!.y);
  expect(linkBox!.y + linkBox!.height).toBeLessThan(codeLabelBox!.y);
  expect(Math.abs(qrBox!.x + qrBox!.width / 2 - (panelBox!.x + panelBox!.width / 2))).toBeLessThan(4);
  expect(Math.abs(codeBox!.x + codeBox!.width / 2 - (panelBox!.x + panelBox!.width / 2))).toBeLessThan(4);
  expect(copyCodeBox!.x).toBeGreaterThan(codeBox!.x + codeBox!.width);
  expect(copyCodeBox!.y).toBeLessThan(codeBox!.y + codeBox!.height);
  expect(Math.abs(iconBox!.x + iconBox!.width / 2 - (copyCodeBox!.x + copyCodeBox!.width / 2))).toBeLessThan(1);
  expect(Math.abs(iconBox!.y + iconBox!.height / 2 - (copyCodeBox!.y + copyCodeBox!.height / 2))).toBeLessThan(1);
  expect(copyCodeBox!.width).toBeGreaterThanOrEqual(43.9);
  expect(copyCodeBox!.height).toBeGreaterThanOrEqual(43.9);
  await expect(copyCode).toHaveAttribute("aria-label", "Copy code");
  await expect(copyCode).toHaveCSS("border-top-width", "0px");
  await expect(copyCode.locator("svg")).toBeVisible();
}

test("mobile link result keeps every handoff visible without horizontal overflow", async ({ page }) => {
  await signedIn(page);
  await writeText(page, "A short note to share");
  await destinations(page).getByRole("button", { name: "Create link" }).click();
  const result = page.locator(".transfer-embedded").first();
  await expect(result.getByRole("img", { name: "QR code for this link" })).toBeVisible();
  await expect(result.locator(".share-access-code .code")).toHaveText(/^[0-9]{3}-[0-9]{3}$/);
  await expect(result.getByRole("button", { name: "Copy link" })).toBeVisible();
  await expect(result.getByRole("button", { name: "Copy link" })).toBeEnabled();
  await expect(result.getByRole("button", { name: "Copy link" })).toHaveClass(/btn-ghost/);
  await expect(result.getByRole("button", { name: "Open in Files" })).toHaveCount(0);
  await expect(result.locator(".transfer-eyebrow")).toHaveCount(0);
  await expect(result.locator(".transfer-hero-name")).toHaveText("Text · 21 characters");
  await expect(result.getByText("Scan to open")).toHaveCount(0);
  expect(await result.innerText()).not.toMatch(/https?:\/\//);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(result.getByRole("img", { name: "QR code for this link" })).toBeInViewport();
  await expect(result.locator(".share-access-code .code")).toBeInViewport();
  await expect(result.getByRole("button", { name: "Copy link" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Done" })).toBeInViewport();
  await expectMobileHandoff(result);
  await expect(destinations(page).getByRole("button", { name: "Save to Files" })).toHaveCount(0);
  await expect(destinations(page).getByRole("button", { name: "Create link" })).toHaveCount(0);

  await page.setViewportSize({ width: 320, height: 700 });
  await page.emulateMedia({ colorScheme: "light" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(result.getByRole("img", { name: "QR code for this link" })).toBeInViewport();
  await expect(result.locator(".share-access-code .code")).toBeInViewport();
  await expect(result.getByRole("button", { name: "Copy link" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Done" })).toBeInViewport();
  await expectMobileHandoff(result);
});
