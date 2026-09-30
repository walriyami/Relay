import { test, expect } from "@playwright/test";
import {
  composer,
  destinations,
  fileInput,
  recordWrites,
  isTransferWrite,
  signedIn,
  textFile,
  writeText,
} from "./helpers";

test("empty destinations stay discoverable across mobile and desktop and never send an empty draft", async ({
  page,
}, testInfo) => {
  const writes = recordWrites(page);
  await signedIn(page);
  await expect.poll(() => writes.includes("POST /api/nearby/presence")).toBe(true);
  const panel = destinations(page);
  const save = panel.getByRole("button", { name: "Save to Files", exact: true });
  const link = panel.getByRole("button", { name: "Create link", exact: true });
  for (const width of [393, 720, 721, 1280]) {
    await page.setViewportSize({ width, height: 852 });
    await expect(save).toBeVisible();
    await expect(link).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(link).toBeDisabled();
    await expect(panel.getByRole("heading", { name: "Your devices" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Add a device" })).toBeEnabled();
    // aria-disabled controls keep focus, but must ignore both pointer and keyboard activation.
    for (const action of [save, link]) {
      await action.dispatchEvent("click");
      await action.press("Enter");
      await action.press("Space");
    }
  }
  expect(writes.filter(isTransferWrite)).toEqual([]);
  await expect(page.locator(".transfer")).toHaveCount(0);

  await page.setViewportSize({ width: 393, height: 852 });
  await page.screenshot({ path: testInfo.outputPath("empty-destinations.png"), fullPage: true });
  await fileInput(page).setInputFiles(textFile("destination-check.txt"));
  await expect(save).toBeEnabled();
  await expect(link).toBeEnabled();
  await composer(page).getByRole("button", { name: "Remove destination-check.txt" }).click();
  await expect(save).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(link).toBeVisible();
  await expect(link).toBeDisabled();

  await writeText(page, "   ");
  await expect(save).toBeDisabled();
  await writeText(page, "Ready to send");
  await expect(save).toBeEnabled();
  await expect(link).toBeEnabled();
  await composer(page).getByRole("button", { name: "Clear", exact: true }).click();
  await expect(save).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(link).toBeVisible();
  await expect(link).toBeDisabled();
  expect(writes.filter(isTransferWrite)).toEqual([]);

  // Positive control: the same observer must detect a real file upload.
  await fileInput(page).setInputFiles(textFile("destination-positive.txt"));
  await save.click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  expect(writes.filter(isTransferWrite)).toContain("POST /api/transfers");
  expect(writes.some((write) => /^PATCH \/uploads\//.test(write))).toBe(true);
  expect(writes.some((write) => /^POST \/api\/transfers\/[^/]+\/complete$/.test(write))).toBe(true);
});

test("device loading and the empty device list are visible before selecting content", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/devices", async (route) => {
    await pending;
    // Other scenarios can leave polling presence alive until its short lease expires.
    // This scenario specifically exercises a loaded, empty destination list.
    await route.fulfill({ json: [] });
  });
  try {
    await page.setViewportSize({ width: 393, height: 852 });
    const laptop = await signedIn(page);
    const panel = destinations(page);
    await expect(panel.getByText("Loading devices…", { exact: true })).toBeVisible();
    release();
    await expect(panel.getByText("Devices show up here while Relay is open on them.", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: laptop, exact: true })).toHaveCount(0);
  } finally {
    release();
  }
});

test("an offline empty composer keeps destinations and explains device availability", async ({ page, context }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await signedIn(page);
  try {
    await context.setOffline(true);
    const panel = destinations(page);
    await expect(panel.getByText("Your devices show up here once you’re connected.", { exact: true })).toBeVisible();
    for (const name of ["Save to Files", "Create link", "Add a device"]) {
      await expect(panel.getByRole("button", { name, exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name, exact: true })).toBeDisabled();
    }
  } finally {
    await context.setOffline(false);
  }
});
