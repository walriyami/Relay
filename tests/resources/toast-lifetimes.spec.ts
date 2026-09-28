import { test, expect } from "@playwright/test";

for (const released of ["pointer", "focus"] as const) {
  test(`toast ${released} exit preserves the other independent hold`, async ({ page }) => {
    await page.goto("/tests/resources/lifetimes.html?modal");
    await page.clock.install();
    await page.getByRole("button", { name: "Add notice" }).click();
    const dismiss = page.getByRole("button", { name: "Dismiss", exact: true });
    const field = page.getByRole("textbox", { name: "Field" });
    await dismiss.focus();
    await dismiss.hover();
    if (released === "pointer") await field.hover();
    else await field.focus();
    await page.clock.runFor(1100);
    await expect(dismiss).toBeVisible();
    if (released === "pointer") {
      await expect(dismiss).toBeFocused();
      await field.focus();
    } else await field.hover();
    await page.clock.runFor(1100);
    await expect(dismiss).toHaveCount(0);
  });
}

test("retired toast region cleanup cannot release the remounted region's focus hold", async ({ page }) => {
  await page.goto("/tests/resources/lifetimes.html");
  await page.clock.install();
  await page.getByRole("button", { name: "Add notice" }).click();
  const dismiss = page.getByRole("button", { name: "Dismiss", exact: true });
  await dismiss.focus();
  await page.evaluate(() => window.remountToaster());
  await expect(dismiss).toBeFocused();
  await page.clock.runFor(1100);
  await expect(dismiss).toBeVisible();
  await expect(dismiss).toBeFocused();
  await page.getByRole("textbox", { name: "Field" }).focus();
  await page.clock.runFor(1100);
  await expect(dismiss).toHaveCount(0);
});

for (const [input, where] of [
  ["mouse", "page"],
  ["keyboard", "page"],
  ["mouse", "modal"],
  ["keyboard", "modal"],
] as const) {
  test(`${input} dismissal of a focused toast in a ${where} leaves the remaining toasts expiring`, async ({ page }) => {
    await page.goto(`/tests/resources/lifetimes.html${where === "modal" ? "?modal" : ""}`);
    await page.clock.install();
    const add = page.getByRole("button", { name: "Add notice" });
    await add.click();
    await add.click();
    const dismiss = page.getByRole("button", { name: "Dismiss", exact: true });
    await expect(dismiss).toHaveCount(2);
    if (input === "mouse") {
      await dismiss.first().focus();
      await dismiss.first().click();
      await page.getByRole("textbox", { name: "Field" }).hover();
    } else {
      await page.mouse.move(5, 5);
      await dismiss.first().focus();
      await page.keyboard.press("Enter");
    }
    await expect(dismiss).toHaveCount(1);
    await page.clock.runFor(3000);
    await expect(dismiss).toHaveCount(0);
  });
}

test("a toast arriving under a resting pointer keeps the hover hold", async ({ page }) => {
  await page.goto("/tests/resources/lifetimes.html");
  await page.clock.install();
  const add = page.getByRole("button", { name: "Add notice" });
  await add.click();
  const dismiss = page.getByRole("button", { name: "Dismiss", exact: true });
  await dismiss.hover();
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(dismiss).toHaveCount(2);
  await page.clock.runFor(2500);
  await expect(dismiss).toHaveCount(2);
});
