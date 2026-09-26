import { devices, expect, test, type Page } from "@playwright/test";
import { BASE, signedIn } from "./helpers";

async function expectReadableEditableControls(page: Page) {
  const tooSmall = await page.locator("input, textarea, select, [contenteditable]").evaluateAll((elements) =>
    elements.flatMap((element) => {
      if (
        element instanceof HTMLInputElement &&
        ![
          "text",
          "email",
          "password",
          "search",
          "tel",
          "url",
          "number",
          "date",
          "datetime-local",
          "month",
          "time",
          "week",
        ].includes(element.type)
      )
        return [];
      if (element instanceof HTMLElement && element.hasAttribute("contenteditable") && !element.isContentEditable)
        return [];
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      return size < 16 ? [`${element.tagName.toLowerCase()}#${element.id}.${element.className}: ${size}px`] : [];
    }),
  );
  expect(tooSmall).toEqual([]);
}

test("editable controls stay at least 16px on iPhone WebKit before focus", async ({ browser, browserName }) => {
  test.skip(browserName !== "webkit", "Safari focus zoom is an iOS WebKit behavior");
  const context = await browser.newContext({ ...devices["iPhone 13"], baseURL: BASE });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await expect(page.getByLabel("Username")).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
    expect(await page.locator('meta[name="viewport"]').getAttribute("content")).not.toMatch(
      /(?:maximum-scale|user-scalable)/,
    );
    await expectReadableEditableControls(page);

    await signedIn(page);
    for (const [path, title] of [
      ["/", "Send"],
      ["/files", "Files"],
      ["/links", "Links"],
      ["/requests", "Requests"],
      ["/settings", "Settings"],
      ["/admin", "Admin"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expectReadableEditableControls(page);
    }

    await page.goto("/requests");
    await page.getByRole("button", { name: "New request" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectReadableEditableControls(page);
  } finally {
    await context.close();
  }
});
