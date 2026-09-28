import { test, expect } from "@playwright/test";
import { api } from "../../shared/api";
import { composer, destinations, deviceContext, fileInput, signedIn, textFile, unique, writeText } from "./helpers";

test("only live devices are offered, and they disappear when closed", async ({ page, browser }) => {
  await signedIn(page, "Laptop");
  const targets = destinations(page);
  await expect(targets.getByRole("button", { name: "Phone" })).toHaveCount(0);
  const phone = await deviceContext(browser, "Phone");
  try {
    // Other browser projects can already own these names; use the server's canonical labels.
    const current = await (await page.request.get(api.session.get.path)).json();
    const remote = await (await phone.page.request.get(api.session.get.path)).json();
    const destination = targets.getByRole("button", { name: remote.device.name, exact: true });
    await expect(destination).toBeVisible({ timeout: 20_000 });
    await expect(destination).toBeDisabled();
    await expect(targets.getByRole("button", { name: current.device.name, exact: true })).toHaveCount(0);
    await writeText(page, "something to send");
    await expect(destination).toBeEnabled();
    await composer(page).getByRole("button", { name: "Clear", exact: true }).click();
    await expect(destination).toBeVisible();
    await expect(destination).toBeDisabled();
  } finally {
    await phone.context.close();
  }
  await expect(targets.getByRole("button", { name: "Phone" })).toHaveCount(0, { timeout: 45_000 });
  await expect(targets.getByText("Devices show up here while Relay is open on them.")).toBeVisible();
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
  await targets.getByRole("button", { name: "Phone" }).click({ timeout: 20_000 });
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
  await expect(card).toContainText("Accepted on Phone");
  await phone.context.close();
});

test("with auto-accept off, a device answers from the popup or from Activity", async ({ page, browser }) => {
  await signedIn(page, "Laptop");
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
    await destinations(page).getByRole("button", { name: "Phone" }).click({ timeout: 20_000 });
    const received = phone.page.getByRole("dialog", { name: new RegExp(`^Text`) });
    await expect(received.getByRole("region", { name: "Text" })).toContainText(`note ${first}`);
    await expect(received).toContainText("Also saved in your Files.");
    await received.getByRole("button", { name: "Decline" }).click();
    await expect(received).toHaveCount(0);
    await expect(page.locator(".transfer").first()).toContainText(/Declined on Phone( \d+)? · still in Files/);
    await composer(page).getByRole("button", { name: "Done" }).click();

    // An arrival never opens over a menu the member is using: it waits until the menu closes. The
    // bell counts it meanwhile, and the tab title says so from any other tab.
    await phone.page.getByRole("button", { name: /^Account:/ }).click();
    const second = unique("waiting");
    await fileInput(page).setInputFiles([textFile(`${second}.txt`, "for later")]);
    await destinations(page).getByRole("button", { name: "Phone" }).click({ timeout: 20_000 });
    await expect(page.locator(".transfer").first()).toContainText(/Sent to Phone( \d+)? · not accepted yet/);
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
    await expect(waiting).toContainText("From Laptop");
    const download = phone.page.waitForEvent("download");
    await waiting.getByRole("button", { name: "Accept" }).click();
    expect((await download).suggestedFilename()).toBe(`${second}.txt`);
    await expect(activity.getByRole("region", { name: "Waiting for you" })).toHaveCount(0);
    await expect(activity.getByRole("region", { name: "Recent activity" })).toContainText(
      `“${second}.txt” from Laptop`,
    );
    await expect(page.locator(".transfer").first()).toContainText("Accepted on Phone");
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
    await destinations(page).getByRole("button", { name: "Phone" }).click({ timeout: 20_000 });
    const card = page.locator(".transfer").first();
    await expect(card).toContainText("Saved, but not sent to Phone");
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
