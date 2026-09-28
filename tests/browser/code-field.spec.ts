import { test, expect, type Page } from "@playwright/test";

// The sign-in code field: one real input over visible boxes.
const field = (page: Page) => page.locator(".code-entry-field-native");
const boxes = (page: Page) => page.locator(".code-entry-field-slot");
const shown = async (page: Page) => (await boxes(page).allTextContents()).join("");
const selection = async (page: Page) =>
  field(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);

let configuredLength: 4 | 6 = 6;

async function paste(page: Page, text: string) {
  await field(page).focus();
  await field(page).evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

test.beforeEach(async ({ page }) => {
  configuredLength = 6;
  await page.route("**/api/pickup/config", async (route) => {
    await route.fulfill({ json: { codeLength: configuredLength } });
  });
  await page.route("**/api/pickup", async (route) => {
    await route.fulfill({ status: 404, json: { error: "No match" } });
  });
  await page.goto("/");
  await expect(field(page)).toBeVisible();
});

test("pasting a copied Relay link or labeled message accepts an exact numeric code", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Only Chromium delivers data in a synthetic paste");
  await paste(page, "https://relay.example/?login=123-456");
  await expect(field(page)).toHaveValue("123-456");
  await paste(page, "http://localhost/pickup?code=654321");
  await expect(field(page)).toHaveValue("654-321");
  await paste(page, "Your code: 012-345. It works once.");
  await expect(field(page)).toHaveValue("012-345");
  // A message that starts with its label is not mistaken for an address.
  await paste(page, "Code: 234-567");
  await expect(field(page)).toHaveValue("234-567");
  await paste(page, "https://relay.example/s/some-share-token");
  await expect(page.getByRole("alert")).toHaveText("Paste a valid 6-digit Relay code.");
  await expect(field(page)).toHaveValue("234-567");
});

test("taps on the boxes reach the input, so the browser can offer Paste", async ({ page }) => {
  const hit = await boxes(page)
    .nth(5)
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.className;
    });
  expect(hit).toContain("code-entry-field-native");
});

test("the code field is a numeric text input that opts out of password managers", async ({ page }) => {
  await expect(field(page)).toHaveAttribute("type", "text");
  await expect(field(page)).toHaveAttribute("name", "relay-code");
  await expect(field(page)).toHaveAttribute("autocomplete", "off");
  await expect(field(page)).toHaveAttribute("inputmode", "numeric");
  await expect(field(page)).toHaveAttribute("data-1p-ignore", "true");
  await expect(field(page)).toHaveAttribute("data-lpignore", "true");
  await expect(field(page)).toHaveAttribute("data-bwignore", "true");
  await expect(field(page)).toHaveAttribute("data-form-type", "other");
});

test("six numeric digits auto-submit once and preserve leading zeroes", async ({ page }) => {
  const attempts: string[] = [];
  await page.route("**/api/pickup", async (route) => {
    attempts.push(route.request().postDataJSON().code);
    await route.fulfill({ status: 404, json: { error: "No match" } });
  });
  await field(page).click();
  await page.keyboard.type("012345");
  await expect(field(page)).toHaveValue("012-345");
  await expect(boxes(page)).toHaveText(["0", "1", "2", "3", "4", "5"]);
  await expect(page.getByRole("alert")).toHaveText("That code isn’t valid or has expired.");
  expect(attempts).toEqual(["012345"]);
});

test("wrong-length and alphanumeric pastes are rejected atomically", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Only Chromium delivers data in a synthetic paste");
  const attempts: string[] = [];
  await page.route("**/api/pickup", async (route) => {
    attempts.push(route.request().postDataJSON().code);
    await route.fulfill({ status: 404, json: { error: "No match" } });
  });
  await paste(page, "12345678");
  await expect(page.getByRole("alert")).toHaveText("Paste a valid 6-digit Relay code.");
  await expect(field(page)).toHaveValue("");
  await paste(page, "ABC123456");
  await expect(field(page)).toHaveValue("");
  expect(attempts).toEqual([]);
});

test("wrong-length and malformed deep links never submit a partial numeric match", async ({ page }) => {
  const attempts: string[] = [];
  await page.route("**/api/pickup", async (route) => {
    attempts.push(route.request().postDataJSON().code);
    await route.fulfill({ status: 404, json: { error: "No match" } });
  });
  await page.goto("/?login=12345678");
  await expect(field(page)).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveText("That link must contain exactly 6 digits.");
  await page.goto("/?login=ABC123456");
  await expect(field(page)).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveText("That link must contain exactly 6 digits.");
  expect(attempts).toEqual([]);
});

test("a chosen box is the one that changes and keyboard navigation follows it", async ({ page }) => {
  await field(page).click();
  await page.keyboard.type("123456");
  await expect(field(page)).toHaveValue("123-456");
  await boxes(page).nth(4).click({ force: true });
  await page.keyboard.type("9");
  expect(await shown(page)).toBe("123496");
  await boxes(page).nth(3).click({ force: true });
  await page.keyboard.press("Backspace");
  expect(await shown(page)).toBe("12396");
  await page.keyboard.press("Home");
  await page.keyboard.type("8");
  expect(await shown(page)).toBe("82396");
});

test("a failed lookup preserves the final selection for correction", async ({ page }) => {
  await field(page).click();
  await page.keyboard.type("123456");
  await expect(page.getByRole("alert")).toHaveText("That code isn’t valid or has expired.");
  await expect(field(page)).toBeFocused();
  await expect(boxes(page).nth(5)).toHaveAttribute("data-current", "true");
  expect(await selection(page)).toEqual([6, 7]);
  await page.keyboard.press("Backspace");
  await expect(field(page)).toHaveValue("123-45");
  await page.keyboard.type("7");
  await expect(field(page)).toHaveValue("123-457");
});

test("a delayed failure preserves a chosen box and does not steal another field's focus", async ({ page }) => {
  let releaseResponse!: () => void;
  let requestStarted!: () => void;
  const responseGate = new Promise<void>((resolve) => (releaseResponse = resolve));
  const requestGate = new Promise<void>((resolve) => (requestStarted = resolve));
  let attempts = 0;
  await page.route("**/api/pickup", async (route) => {
    attempts++;
    if (attempts === 1) {
      requestStarted();
      await responseGate;
    }
    await route.fulfill({ status: 404, json: { error: "No match" } });
  });
  await field(page).click();
  await page.keyboard.type("123456");
  await requestGate;
  try {
    await expect(page.getByRole("status").and(page.locator(".field-hint"))).toHaveText("Checking code…");
    await boxes(page).nth(3).click({ force: true });
    await expect(boxes(page).nth(3)).toHaveAttribute("data-current", "true");
    await expect.poll(() => selection(page)).toEqual([4, 5]);
    await page.getByLabel("Username").focus();
    await expect(page.getByLabel("Username")).toBeFocused();
  } finally {
    releaseResponse();
  }
  await expect(page.getByRole("alert")).toHaveText("That code isn’t valid or has expired.");
  await expect(page.getByLabel("Username")).toBeFocused();
  await expect(boxes(page).nth(3)).toHaveAttribute("data-current", "true");
  expect(await selection(page)).toEqual([4, 5]);
  await expect(field(page)).not.toBeFocused();
  expect(attempts).toBe(1);
});

test("four-digit mode preserves a leading zero and displays four boxes", async ({ page }) => {
  configuredLength = 4;
  await page.goto("/?login=0123");
  await expect(field(page)).toHaveValue("0123");
  await expect(boxes(page)).toHaveText(["0", "1", "2", "3"]);
  await expect(field(page)).toHaveAttribute("placeholder", "XXXX");
});

test("refreshing a changed deployment length clears partial input with an explanation", async ({ page }) => {
  await field(page).fill("12");
  configuredLength = 4;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(field(page)).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveText("Code length changed to 4 digits. Enter the code again.");
  await expect(boxes(page)).toHaveCount(4);
});

test("pre-submit refresh refuses a stale six-digit code when deployment switches to four", async ({ page }) => {
  const attempts: string[] = [];
  await page.route("**/api/pickup", async (route) => {
    attempts.push(route.request().postDataJSON().code);
    await route.fulfill({ status: 404, json: { error: "No match" } });
  });
  await field(page).click();
  await page.keyboard.type("12345");
  configuredLength = 4;
  await page.keyboard.type("6");
  await expect(field(page)).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveText("Code length changed to 4 digits. Enter the code again.");
  expect(attempts).toEqual([]);
});

test("config load failures block entry and can be retried", async ({ page }) => {
  await page.unroute("**/api/pickup/config");
  let shouldFail = true;
  await page.route("**/api/pickup/config", async (route) => {
    if (shouldFail) await route.fulfill({ status: 503, json: { error: "Unavailable" } });
    else await route.fulfill({ json: { codeLength: configuredLength } });
  });
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Could not load the current code settings.");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  configuredLength = 4;
  shouldFail = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(field(page)).toBeVisible();
  await expect(boxes(page)).toHaveCount(4);
});

test("a tapped box is the one that changes on a touch screen", async ({ page }, { project }) => {
  test.skip(!project.use.hasTouch, "Touch only");
  await field(page).tap();
  await page.keyboard.type("123456");
  await boxes(page).nth(2).tap({ force: true });
  await page.keyboard.type("9");
  expect(await shown(page)).toBe("129456");
});

test("a digit typed after a Backspace in the first group lands where the caret is", async ({ page }) => {
  await field(page).click();
  await page.keyboard.type("123456");
  await expect(field(page)).toHaveValue("123-456");
  // Caret after the 4, then Backspace and a new digit: the code is regrouped, nothing dropped.
  await field(page).evaluate((el: HTMLInputElement) => el.setSelectionRange(5, 5));
  await page.keyboard.press("Backspace");
  await expect(field(page)).toHaveValue("123-56");
  await page.keyboard.type("7");
  await expect(field(page)).toHaveValue("123-756");
});

test("Enter on an unfinished code says what is missing", async ({ page }) => {
  await field(page).click();
  await page.keyboard.type("12");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Enter all 6 digits.");
  await expect(field(page)).toHaveValue("12");
});

test("digits typed into a shortened code are inserted, never written over the next one", async ({ page }) => {
  await field(page).click();
  await page.keyboard.type("123456");
  await expect(field(page)).toHaveValue("123-456");
  await field(page).evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 3));
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(field(page)).toHaveValue("145-6");
  await page.keyboard.type("78");
  await expect(field(page)).toHaveValue("178-456");
});

test("a refused letter leaves the chosen box chosen, so the next digit goes there", async ({ page }) => {
  await field(page).click();
  await page.keyboard.type("12456");
  await expect(field(page)).toHaveValue("124-56");
  // Choose the box holding the 4, try a letter, then the digit that belongs there.
  await field(page).evaluate((el: HTMLInputElement) => el.setSelectionRange(2, 3));
  await page.keyboard.type("a");
  await expect(field(page)).toHaveValue("124-56");
  expect(await selection(page)).toEqual([2, 3]);
  await page.keyboard.type("3");
  await expect(field(page)).toHaveValue("123-56");
});
