import { test, expect } from "@playwright/test";
import {
  BASE,
  composer,
  destinations,
  deviceContext,
  deviceName,
  deviceState,
  endingWith,
  fileInput,
  signedIn,
  textFile,
  unique,
  writeText,
} from "./helpers";

test("a device that isn't open is offered, and gets what was sent the next time it opens Relay", async ({
  page,
  browser,
}) => {
  const laptop = await signedIn(page, "Laptop");
  const targets = destinations(page);
  const phoneName = await deviceName("Phone");
  // Signed in, but Relay isn't open on it: still a place to send, and it says when it will get it.
  const destination = targets.getByRole("button", { name: phoneName, exact: true });
  await expect(destination).toBeEnabled({ timeout: 20_000 });
  await expect(destination).toHaveAccessibleDescription(/Away · gets it when it opens Relay/);
  await expect(targets.getByRole("button", { name: laptop, exact: true })).toHaveCount(0);
  const name = unique("queued");
  await fileInput(page).setInputFiles([textFile(`${name}.txt`, "for later")]);
  await destination.click();
  const card = page.locator(".transfer").first();
  // Never "sent" while nothing has it: it waits, and it is safe in Files meanwhile.
  await expect(card.getByRole("status")).toHaveText(
    endingWith(`: Waiting for ${phoneName} to open Relay · copy kept in Files`),
  );
  await expect(destination).toHaveAccessibleDescription("Waiting for it to open Relay");
  // Opening Relay on the phone later is enough: auto-accept is on, so a file alone downloads there
  // and says so, and the laptop is told.
  const phone = await browser.newContext({ baseURL: BASE, storageState: await deviceState("Phone") });
  try {
    const phonePage = await phone.newPage();
    const download = phonePage.waitForEvent("download");
    await phonePage.goto("/");
    expect((await download).suggestedFilename()).toBe(`${name}.txt`);
    await expect(phonePage.getByText(`Downloading “${name}.txt” from ${laptop}`)).toBeVisible();
    await expect(card.getByRole("status")).toHaveText(endingWith(`: Downloaded on ${phoneName} · copy kept in Files`));
  } finally {
    await phone.close();
  }
});

test("a device accepts what your others send it: it downloads and opens in a popup, no new tabs", async ({
  page,
  browser,
}) => {
  await signedIn(page, "Laptop");
  const phone = await deviceContext(browser, "Phone");
  const name = unique("delivery");
  const targets = destinations(page);
  await fileInput(page).setInputFiles([textFile(`${name}.txt`, "attached file")]);
  await writeText(page, `wifi password for ${name}`);
  const download = phone.page.waitForEvent("download");
  await targets.getByRole("button", { name: phone.name, exact: true }).click({ timeout: 20_000 });
  const card = page.locator(".transfer").first();

  // Auto-accept is on by default: the phone downloads the file (text is shown, never downloaded)
  // and shows it straight away.
  expect((await download).suggestedFilename()).toBe(`${name}.txt`);
  const received = phone.page.getByRole("dialog", { name: new RegExp(name) });
  const text = received.getByRole("region", { name: "Text" });
  await expect(text).toContainText(`wifi password for ${name}`);
  await expect(text.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(received.getByRole("region", { name: `Preview of ${name}.txt` })).toContainText("attached file");
  await expect(received).toContainText("Accepted on this device. Also saved in your Files.");
  await expect(received.getByRole("button", { name: "Open in Files" })).toBeVisible();
  await expect(received.getByRole("button", { name: /^Download/ })).toBeVisible();
  await expect(received.getByRole("button", { name: /Remove/ })).toHaveCount(0);
  expect(phone.context.pages()).toHaveLength(1);
  await expect(phone.page).toHaveURL(/\/$/);

  // The sender is told exactly that, and nothing more.
  await expect(card.getByRole("status")).toHaveText(endingWith(`: Downloaded on ${phone.name} · copy kept in Files`));
  await phone.context.close();
});

test("with auto-accept off, a device answers from the popup or from Activity", async ({ page, browser }) => {
  const laptop = await signedIn(page, "Laptop");
  const phone = await deviceContext(browser, "Phone");
  try {
    await phone.page.getByRole("button", { name: /^Account:/ }).click();
    const auto = phone.page.getByRole("menuitemcheckbox", { name: "Auto-accept" });
    await expect(auto).toHaveAttribute("aria-checked", "true");
    await auto.click();
    await expect(auto).toHaveAttribute("aria-checked", "false");
    await phone.page.keyboard.press("Escape");

    // Declined in the popup: it stays in Files, and the sender is told so.
    const first = unique("declined");
    await writeText(page, `note ${first}`);
    await destinations(page).getByRole("button", { name: phone.name, exact: true }).click({ timeout: 20_000 });
    const received = phone.page.getByRole("dialog", { name: new RegExp(`^Text`) });
    await expect(received.getByRole("region", { name: "Text" })).toContainText(`note ${first}`);
    await expect(received).toContainText("Also saved in your Files.");
    await received.getByRole("button", { name: "Decline" }).click();
    await expect(received).toHaveCount(0);
    await expect(page.locator(".transfer").first().getByRole("status")).toHaveText(
      endingWith(`: Declined on ${phone.name} · still in Files`),
    );
    await composer(page).getByRole("button", { name: "Done" }).click();

    // An arrival never opens over a menu the member is using: it waits until the menu closes. The
    // bell counts it meanwhile, and the tab title says so from any other tab.
    await phone.page.getByRole("button", { name: /^Account:/ }).click();
    const second = unique("waiting");
    await fileInput(page).setInputFiles([textFile(`${second}.txt`, "for later")]);
    await destinations(page).getByRole("button", { name: phone.name, exact: true }).click({ timeout: 20_000 });
    const card = page.locator(".transfer").first();
    await expect(card.getByRole("status")).toHaveText(endingWith(`: Delivered to ${phone.name} · copy kept in Files`));
    const popup = phone.page.getByRole("dialog", { name: `${second}.txt` });
    await expect(phone.page.getByRole("button", { name: /^Activity, \d+ new$/ })).toBeVisible();
    await expect(popup).toHaveCount(0);
    await phone.page.keyboard.press("Escape");
    await expect(popup.getByRole("button", { name: "Accept and download" })).toBeVisible();
    await expect(phone.page).toHaveTitle(/^\(\d+\) Relay$/);
    await popup.getByRole("button", { name: "Close" }).click();

    const bell = phone.page.getByRole("button", { name: /^Activity, \d+ new$/ });
    await bell.click();
    const activity = phone.page.getByRole("dialog", { name: "Activity" });
    const waiting = activity.getByRole("region", { name: "Waiting for you" }).getByRole("listitem");
    await expect(waiting).toHaveCount(1);
    await expect(waiting).toContainText(`${second}.txt`);
    await expect(waiting).toContainText(`From ${laptop} · `);
    const download = phone.page.waitForEvent("download");
    await waiting.getByRole("button", { name: "Accept" }).click();
    expect((await download).suggestedFilename()).toBe(`${second}.txt`);
    await expect(activity.getByRole("region", { name: "Waiting for you" })).toHaveCount(0);
    await expect(
      activity.getByRole("region", { name: "Recent activity" }).getByText(endingWith(`“${second}.txt” from ${laptop}`)),
    ).toBeVisible();
    await expect(card.getByRole("status")).toHaveText(endingWith(`: Downloaded on ${phone.name} · copy kept in Files`));
    await expect(phone.page).toHaveTitle("Relay");
    await expect(phone.page.getByRole("button", { name: "Activity", exact: true })).toBeVisible();

    // Clicking anywhere else closes it.
    await phone.page.locator("main").click({ position: { x: 5, y: 5 } });
    await expect(activity).toHaveCount(0);
  } finally {
    await phone.context.close();
  }
});

test("a delivery that fails leaves everything saved, and Done keeps it in Files", async ({ page, browser }) => {
  await signedIn(page, "Laptop");
  const phone = await deviceContext(browser, "Phone");
  try {
    const name = unique("delivery-failed");
    await page.route("**/api/transfers/*/complete", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "That device is not online." }),
      }),
    );
    await fileInput(page).setInputFiles([textFile(`${name}.txt`, "for the phone")]);
    await destinations(page).getByRole("button", { name: phone.name, exact: true }).click({ timeout: 20_000 });
    const card = page.locator(".transfer").first();
    await expect(card.getByRole("status")).toHaveText(`Saved, but not sent to ${phone.name}`);
    // Nothing is running any more, so the drop box says so and offers Done.
    await expect(composer(page)).toContainText("Everything is saved in Files. Done keeps it there.");
    await expect(composer(page)).not.toContainText("Keep this tab open");
    await page.unroute("**/api/transfers/*/complete");
    await composer(page).getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".transfer")).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "Recent" }).getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toBeVisible();
  } finally {
    await phone.context.close();
  }
});

test("the Activity popup sits directly under its bell", async ({ page }) => {
  await signedIn(page, "Laptop");
  const button = page.getByRole("button", { name: /^Activity(, \d+ new)?$/ });
  await button.click();
  const popover = page.getByRole("dialog", { name: "Activity" });
  await expect(popover).toBeVisible();
  const b = (await button.boundingBox())!;
  const p = (await popover.boundingBox())!;
  expect(p.y - (b.y + b.height)).toBeGreaterThanOrEqual(0);
  expect(p.y - (b.y + b.height)).toBeLessThanOrEqual(10);
  expect(p.x).toBeLessThanOrEqual(b.x + b.width);
  expect(p.x + p.width).toBeGreaterThanOrEqual(b.x);
  // Opening it sees everything in it, on every device of the account.
  await expect(popover.getByRole("region", { name: "Recent activity" })).toContainText("signed in");
  await expect(button).toHaveAccessibleName("Activity");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(button).toBeFocused();
});
