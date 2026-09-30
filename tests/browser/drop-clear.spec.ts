import { test, expect, type Page } from "@playwright/test";
import { destinations, signedIn, textFile } from "./helpers";

type DropGate = { started: boolean; release: () => void };
async function holdFolder(page: Page) {
  await page.evaluate(() => {
    const gate: DropGate = { started: false, release: () => {} };
    (window as unknown as { dropGate: DropGate }).dropGate = gate;
    let delivered = false;
    const folder = {
      name: "held-folder",
      isDirectory: true,
      isFile: false,
      createReader: () => ({
        readEntries: (callback: (entries: unknown[]) => void) => {
          if (delivered) return callback([]);
          gate.started = true;
          gate.release = () => {
            delivered = true;
            callback([
              {
                name: "stale.txt",
                isFile: true,
                isDirectory: false,
                file: (done: (file: File) => void) => done(new File(["held"], "stale.txt")),
              },
            ]);
          };
        },
      }),
    };
    const event = new DragEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        types: ["Files"],
        items: [{ webkitGetAsEntry: () => folder, getAsFile: () => null }],
      },
    });
    document.dispatchEvent(event);
  });
  expect(await page.evaluate(() => (window as unknown as { dropGate: DropGate }).dropGate.started)).toBe(true);
}
async function releaseFolder(page: Page) {
  await page.evaluate(async () => {
    (window as unknown as { dropGate: DropGate }).dropGate.release();
    // Synthetic reader/file callbacks are synchronous. All enumeration and delivery promise
    // continuations drain before the next rendering frame, even if Send is currently unmounted.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await expect(page.getByText("Reading what you dropped…", { exact: true })).toHaveCount(0);
}
const selected = (page: Page) => page.getByRole("list", { name: "Selected items" });

test.beforeEach(async ({ page }) => {
  await signedIn(page, "Drop lifecycle");
  await page.getByTestId("file-input").setInputFiles(textFile("initial.txt"));
});

for (const next of ["empty", "new selection", "Undo"] as const) {
  test(`Clear invalidates held folder enumeration: ${next}`, async ({ page }) => {
    await page.getByRole("button", { name: "Clear", exact: true }).first().focus();
    await holdFolder(page);
    await page.keyboard.press("Enter");
    await expect(selected(page)).toHaveCount(0);
    if (next === "new selection") await page.getByTestId("file-input").setInputFiles(textFile("new-selection.txt"));
    if (next === "Undo") {
      // The reading overlay covers pointer targets; Undo remains available by keyboard.
      await page.getByRole("button", { name: "Undo", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(selected(page)).toContainText("initial.txt");
    }
    await releaseFolder(page);
    if (next === "empty") await expect(selected(page)).toHaveCount(0);
    else {
      await expect(selected(page).getByRole("listitem")).toHaveCount(1);
      await expect(selected(page)).toContainText(next === "Undo" ? "initial.txt" : "new-selection.txt");
      await expect(selected(page)).not.toContainText("held-folder");
    }
  });
}

test("ordinary additions preserve held folder enumeration", async ({ page }) => {
  await holdFolder(page);
  await page.getByTestId("file-input").setInputFiles(textFile("new-selection.txt"));
  await releaseFolder(page);
  await expect(selected(page).getByRole("listitem")).toHaveCount(3);
  for (const name of ["initial.txt", "new-selection.txt", "held-folder"])
    await expect(selected(page)).toContainText(name);
});

test("navigation preserves the owning Send draft and held enumeration", async ({ page }) => {
  await page.getByRole("link", { name: "Nearby", exact: true }).focus();
  await holdFolder(page);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Nearby", exact: true })).toBeVisible();
  await releaseFolder(page);
  await page.getByRole("link", { name: "Send", exact: true }).click();
  await expect(selected(page).getByRole("listitem")).toHaveCount(2);
  await expect(selected(page)).toContainText("initial.txt");
  await expect(selected(page)).toContainText("held-folder");
});

test("sending clears the draft without reviving held folder enumeration", async ({ page }) => {
  await destinations(page).getByRole("button", { name: "Save to Files", exact: true }).focus();
  await holdFolder(page);
  await page.keyboard.press("Enter");
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await releaseFolder(page);
  await expect(selected(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(selected(page)).toHaveCount(0);
});
