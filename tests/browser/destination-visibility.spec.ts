import { test, expect } from "@playwright/test";
import { composer, destinations, recordWrites, isBackgroundWrite, signedIn, textFile, writeText } from "./helpers";

test("with nothing added, a destination opens the picker and sends there once files are chosen", async ({
  page,
}, testInfo) => {
  const writes = recordWrites(page);
  await signedIn(page);
  await expect.poll(() => writes.includes("POST /api/nearby/presence")).toBe(true);
  const panel = destinations(page);
  const save = panel.getByRole("button", { name: "Save to Files", exact: true });
  const link = panel.getByRole("button", { name: "Create link", exact: true });
  const armed = composer(page).getByRole("status").filter({ hasText: "Choose what to send to" });
  for (const width of [393, 720, 721, 1280]) {
    await page.setViewportSize({ width, height: 852 });
    // Nothing is greyed out: every destination is a way to start.
    await expect(save).toBeEnabled();
    await expect(link).toBeEnabled();
    await expect(panel.getByRole("heading", { name: "Your devices" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Add a device" })).toBeEnabled();
  }
  await page.setViewportSize({ width: 393, height: 852 });
  await page.screenshot({ path: testInfo.outputPath("empty-destinations.png"), fullPage: true });

  // Choosing a destination first opens the picker; nothing is sent until something is chosen.
  let chooser = page.waitForEvent("filechooser");
  await link.press("Enter");
  await chooser;
  await expect(armed).toContainText("a new link");
  await armed.getByRole("button", { name: "Cancel" }).click();
  await expect(armed).toHaveCount(0);
  expect(writes.filter((write) => !isBackgroundWrite(write))).toEqual([]);
  await expect(page.locator(".transfer")).toHaveCount(0);

  // Typed text alone never sends to a destination chosen earlier.
  chooser = page.waitForEvent("filechooser");
  await save.click();
  await chooser;
  await expect(armed).toContainText("Files");
  await writeText(page, "Ready to send");
  await expect(page.locator(".transfer")).toHaveCount(0);
  await armed.getByRole("button", { name: "Cancel" }).click();
  await composer(page).getByRole("button", { name: "Clear", exact: true }).click();
  expect(writes.filter((write) => !isBackgroundWrite(write))).toEqual([]);

  // Picked for Save to Files: it is saved without a second step.
  chooser = page.waitForEvent("filechooser");
  await save.click();
  await (await chooser).setFiles(textFile("destination-positive.txt"));
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await expect(armed).toHaveCount(0);
  expect(writes).toContain("POST /api/transfers");
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
    await expect(
      panel.getByText("Sign in to Relay on your phone or another computer to send to it.", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("button", { name: laptop, exact: true })).toHaveCount(0);
  } finally {
    release();
  }
});

test("an offline empty composer keeps destinations and says sending is paused", async ({ page, context }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await signedIn(page);
  try {
    await context.setOffline(true);
    const panel = destinations(page);
    await expect(panel.getByText(/Sending is paused until you’re back online/)).toBeVisible();
    for (const name of ["Save to Files", "Create link", "Add a device"]) {
      await expect(panel.getByRole("button", { name, exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name, exact: true })).toBeDisabled();
    }
  } finally {
    await context.setOffline(false);
  }
});
