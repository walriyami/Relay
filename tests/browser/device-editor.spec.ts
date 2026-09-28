import { test, expect, request, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { api, headers } from "../../shared/api";
import type { DeviceKind, Me } from "../../shared/model";
import { BASE, destinations, deviceContext, deviceState, signedIn, unique, writeText } from "./helpers";

test.use({ reducedMotion: "reduce" });

// Sign-ins are limited to 10 a minute per address, so these tests share three devices and read
// their names and icons as they are now instead of signing in a fresh device each time.
const EDITOR = "Device editor";
const REMOTE = "Device editor remote";
const OFFLINE = "Device editor offline";
const ICONS: Record<DeviceKind, { label: string; lucide: RegExp }> = {
  computer: { label: "Computer", lucide: /lucide-laptop/ },
  phone: { label: "Phone", lucide: /lucide-smartphone/ },
  tablet: { label: "Tablet", lucide: /lucide-tablet/ },
};
/** An icon other than the device's current one, so choosing it is always a change. */
const otherKind = (kind: DeviceKind): DeviceKind => (kind === "tablet" ? "phone" : "tablet");
/** The line under Destinations that names this device and opens its editor. */
const thisDevice = (page: Page, name: string) =>
  destinations(page).getByRole("button", { name: `Edit this device, ${name}`, exact: true });
const hovers = (page: Page) => page.evaluate(() => matchMedia("(hover: hover)").matches);

async function me(page: Page): Promise<Me> {
  return (await page.request.get(api.session.get.path)).json();
}
/** Signs this page in as the shared editor device and returns it as it currently is. */
async function asEditor(page: Page) {
  await deviceState(OFFLINE);
  await signedIn(page, EDITOR);
  return me(page);
}

test("Destinations edits this device before composing, with keyboard icon selection and persistence", async ({
  page,
}) => {
  const before = await asEditor(page);
  const name = before.device.name;
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const edit = thisDevice(page, name);
  await expect(edit.locator("svg").first()).toHaveClass(ICONS[before.device.kind].lucide);
  await edit.click();
  const dialog = page.getByRole("dialog", { name: "Edit this device", exact: true });
  const field = dialog.getByRole("textbox", { name: "Device name" });
  await expect(field).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(dialog.locator(`input[type="radio"][value="${before.device.kind}"]`)).toBeChecked();
  const computer = dialog.getByRole("radio", { name: "Computer", exact: true });
  await computer.check();
  await computer.focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("radio", { name: "Phone", exact: true })).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("radio", { name: "Tablet", exact: true })).toBeChecked();
  const renamed = unique("Studio");
  await field.fill(`  ${renamed}  `);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  const edited = thisDevice(page, renamed);
  await expect(edited).toBeFocused();
  await expect(edited.locator("svg").first()).toHaveClass(/lucide-tablet/);
  expect(writes.filter((write) => /\/(transfers|deliveries|devices)/.test(write))).toEqual([
    `PATCH /api/devices/${before.device.id}`,
  ]);
  await page.getByRole("button", { name: /^Account:/ }).click();
  const account = page.getByRole("menuitem", { name: `Edit this device, ${renamed}`, exact: true });
  await expect(account.locator("svg").first()).toHaveClass(/lucide-tablet/);
  await account.click();
  await expect(dialog.getByRole("textbox", { name: "Device name" })).toHaveValue(renamed);
  await expect(dialog.getByRole("radio", { name: "Tablet", exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await expect(edited.locator("svg").first()).toHaveClass(/lucide-tablet/);
  await page.goto("/settings");
  const current = page
    .getByRole("region", { name: "Devices" })
    .getByRole("listitem")
    .filter({ hasText: "This browser" });
  await expect(current).toContainText(renamed);
  await expect(current.locator(".device-icon svg")).toHaveClass(/lucide-tablet/);
  await current.getByRole("button", { name: "Edit this device", exact: true }).click();
  // An icon-only edit also saves, while the name stays untouched.
  await dialog.getByRole("radio", { name: "Phone", exact: true }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  const after = await me(page);
  expect(after.device).toMatchObject({ id: before.device.id, name: renamed, kind: "phone" });
});

test("editing another live device updates both browsers and preserves the pending send", async ({ page, browser }) => {
  await asEditor(page);
  const remote = await deviceContext(browser, REMOTE);
  try {
    const remoteName = (await me(remote.page)).device.name;
    await expect(destinations(page).getByRole("button", { name: remoteName, exact: true })).toBeVisible();
    await writeText(page, "Keep this draft while editing");
    await remote.page.getByRole("button", { name: /^Account:/ }).click();
    const row = destinations(page).locator(".destination-wrap").filter({ hasText: remoteName });
    const pencil = destinations(page).getByRole("button", { name: `Edit ${remoteName}`, exact: true });
    const opacity = () => row.locator(".destination-accessory").evaluate((node) => getComputedStyle(node).opacity);
    // On screens with a pointer the pencil waits for the row to be pointed at or reached by keyboard;
    // touch screens show it in place of the chevron.
    if (await hovers(page)) {
      await page.mouse.move(0, 0);
      await expect.poll(opacity).toBe("0");
      await row.hover();
      await expect.poll(opacity).toBe("1");
      await page.mouse.move(0, 0);
      await pencil.focus();
      await expect.poll(opacity).toBe("1");
    } else await expect.poll(opacity).toBe("1");
    await pencil.click();
    const dialog = page.getByRole("dialog", { name: "Edit device", exact: true });
    const renamed = unique("Pocket");
    await dialog.getByRole("textbox", { name: "Device name" }).fill(renamed);
    await dialog.getByRole("radio", { name: "Phone", exact: true }).check();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(destinations(page).getByRole("button", { name: `Edit ${renamed}`, exact: true })).toBeFocused();
    const target = destinations(page).getByRole("button", { name: renamed, exact: true });
    await expect(target).toBeEnabled();
    await expect(target.locator("svg").first()).toHaveClass(/lucide-smartphone/);
    const remoteAccount = remote.page.getByRole("menuitem", { name: `Edit this device, ${renamed}`, exact: true });
    await expect(remoteAccount.locator("svg").first()).toHaveClass(/lucide-smartphone/);
    await expect(page.locator("#composer-text")).toHaveValue("Keep this draft while editing");
    await remote.page.keyboard.press("Escape");
    await target.click();
    await expect(remote.page.getByRole("dialog").getByRole("region", { name: "Text", exact: true })).toContainText(
      "Keep this draft while editing",
    );
  } finally {
    await remote.context.close();
  }
});

test("offline devices are edited from Settings, and cancel and invalid names do not change them", async ({ page }) => {
  // Signed in, but never opened.
  const context = await request.newContext({ baseURL: BASE, storageState: await deviceState(OFFLINE) });
  const { id } = (await (await context.get(api.session.get.path)).json()).device;
  await context.dispose();
  await asEditor(page);
  const devices = await (await page.request.get(api.devices.list.path)).json();
  const device = devices.find((d: { id: string }) => d.id === id);
  const offline: string = device.name;
  const target = ICONS[otherKind(device.kind)];
  expect(device.online).toBe(false);
  // Destinations lists only devices that can receive now, so an offline one isn't there to edit.
  await expect(destinations(page).getByRole("button", { name: offline, exact: true })).toHaveCount(0);
  await expect(destinations(page).getByRole("button", { name: `Edit ${offline}`, exact: true })).toHaveCount(0);
  await page.goto("/settings");
  const row = page.getByRole("region", { name: "Devices" }).getByRole("listitem").filter({ hasText: offline });
  const open = async () => {
    await row.getByRole("button", { name: `Actions for ${offline}` }).click();
    await page.getByRole("menuitem", { name: "Edit name and icon", exact: true }).click();
  };
  await open();
  const dialog = page.getByRole("dialog", { name: "Edit device", exact: true });
  await dialog.getByRole("textbox", { name: "Device name" }).fill("   ");
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Device name" }).fill("Unsaved name");
  await dialog.getByRole("radio", { name: "Tablet", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await open();
  await expect(dialog.getByRole("textbox", { name: "Device name" })).toHaveValue(offline);
  await expect(dialog.locator(`input[type="radio"][value="${device.kind}"]`)).toBeChecked();
  await dialog.getByRole("radio", { name: target.label, exact: true }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row.locator(".device-icon svg")).toHaveClass(target.lucide);
  await page.reload();
  await expect(row.locator(".device-icon svg")).toHaveClass(target.lucide);
  await open();
  await expect(dialog.getByRole("radio", { name: target.label, exact: true })).toBeChecked();
});

test("failed saves keep both edits, prevent duplicate submissions, and can be retried", async ({ page }) => {
  const before = await asEditor(page);
  const name = before.device.name;
  const target = ICONS[otherKind(before.device.kind)];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  await page.route(`**/api/devices/${before.device.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    attempts++;
    if (attempts > 1) return route.continue();
    await held;
    await route.fulfill({ status: 500, json: { error: "Couldn’t save the device. Try again." } });
  });
  try {
    await thisDevice(page, name).click();
    const dialog = page.getByRole("dialog", { name: "Edit this device", exact: true });
    const renamed = unique("Retried");
    await dialog.getByRole("textbox", { name: "Device name" }).fill(renamed);
    await dialog.getByRole("radio", { name: target.label, exact: true }).check();
    const save = dialog.getByRole("button", { name: "Save", exact: true });
    await save.click();
    await expect(save).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    expect(attempts).toBe(1);
    release();
    await expect(dialog.getByRole("alert")).toHaveText("Couldn’t save the device. Try again.");
    await expect(dialog.getByRole("textbox", { name: "Device name" })).toHaveValue(renamed);
    await expect(dialog.getByRole("radio", { name: target.label, exact: true })).toBeChecked();
    expect((await me(page)).device).toEqual(before.device);
    await save.click();
    await expect(dialog).toBeHidden();
    expect(attempts).toBe(2);
    expect((await me(page)).device).toMatchObject({ name: renamed, kind: otherKind(before.device.kind) });
  } finally {
    release();
  }
});

for (const dismiss of ["Escape", "Back"] as const) {
  test(`${dismiss} during a save keeps the dialog registered for dismissal after a failure`, async ({ page }) => {
    const current = await asEditor(page);
    const name = current.device.name;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/devices/${current.device.id}`, async (route) => {
      await held;
      await route.fulfill({ status: 500, json: { error: "Try again." } });
    });
    try {
      const edit = thisDevice(page, name);
      await edit.click();
      const dialog = page.getByRole("dialog", { name: "Edit this device", exact: true });
      await dialog.getByRole("textbox", { name: "Device name" }).fill(unique("Changed"));
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
      if (dismiss === "Back") {
        const popped = page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              window.addEventListener("popstate", () => resolve(), { once: true });
              history.back();
            }),
        );
        await popped;
      } else await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      release();
      await expect(dialog.getByRole("alert")).toHaveText("Try again.");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(edit).toBeFocused();
    } finally {
      release();
    }
  });
}

test("long device names and the editor fit small screens, dark mode, and enlarged text", async ({ page }, testInfo) => {
  const longName = (unique("Long") + "x".repeat(180)).slice(0, 180);
  const remoteName = "Remote " + "y".repeat(120);
  await page.route("**/api/devices", async (route) => {
    const devices = await (await route.fetch()).json();
    const current = devices.find((device: { current: boolean }) => device.current);
    await route.fulfill({
      json: [
        current,
        { ...current, id: "layout-remote", name: remoteName, kind: "phone", current: false, online: true },
        ...Array.from({ length: 18 }, (_, index) => ({
          ...current,
          id: `layout-${index}`,
          name: `Office device ${index + 1}`,
          current: false,
          online: false,
        })),
      ],
    });
  });
  const current = await asEditor(page);
  const renamed = await page.request.patch(api.devices.update.path.replace(":id", current.device.id), {
    headers: { [headers.csrf]: current.csrf },
    data: { name: longName },
  });
  expect(renamed.ok()).toBe(true);
  await page.reload();
  const panel = destinations(page);
  const edit = thisDevice(page, longName);
  for (const [label, width, theme, fontSize] of [
    ["desktop-light", 1280, "light", "100%"],
    ["mobile-dark", 393, "dark", "100%"],
    ["narrow-light", 320, "light", "100%"],
    ["large-text-dark", 320, "dark", "200%"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = size;
    }, fontSize);
    await expect(panel.getByRole("button", { name: remoteName, exact: true })).toBeVisible();
    await expect(edit).toBeVisible();
    for (const node of [panel, edit, panel.locator(".destination-wrap").filter({ hasText: remoteName })]) {
      expect(await node.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    // Long names are cut short in place rather than pushing the pencil or the panel wider.
    const editBox = (await edit.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    expect(editBox.x + editBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath(`${label}-destinations.png`), fullPage: true });
    await edit.click();
    const dialog = page.getByRole("dialog", { name: "Edit this device", exact: true });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    for (const choice of await dialog.locator(".device-icon-choice").all()) {
      expect(await choice.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${label}-editor.png`), fullPage: true });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  }
});

test("with no other device signed in, Destinations shows no edit controls, only this device's name", async ({
  page,
}, testInfo) => {
  await page.route("**/api/devices", async (route) => {
    const devices = await (await route.fetch()).json();
    await route.fulfill({ json: devices.filter((device: { current: boolean }) => device.current) });
  });
  const { device } = await asEditor(page);
  const panel = destinations(page);
  await expect(panel.getByRole("button", { name: "Add a device" })).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Edit(?! this device,)/ })).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Your devices" }).getByRole("button")).toHaveCount(0);
  const edit = thisDevice(page, device.name);
  await expect(edit).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath("empty-destinations.png") });
  await edit.click();
  const dialog = page.getByRole("dialog", { name: "Edit this device", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Device name" })).toHaveValue(device.name);
  await expect(dialog.getByRole("textbox", { name: "Device name" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(edit).toBeFocused();
});
