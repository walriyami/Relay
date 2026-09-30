import { expect, test, type Browser, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { readFile, truncate, writeFile } from "node:fs/promises";
import { copyShareUrl, deviceContext, unique } from "./helpers.ts";

// Nearby connects the two browsers straight to each other, by their local addresses. Chromium hides
// those behind mDNS names unless told not to, and resolving them isn't something a test machine can
// count on; Firefox and WebKit give no local candidates to pages without camera access at all.
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Needs local ICE candidates, which only Chromium can be told to give.",
);
test.use({ launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] } });
test.describe.configure({ mode: "serial" });

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const sendTo = (page: Page) => page.getByRole("complementary", { name: "Send to" });
const transfers = (page: Page) => page.getByRole("region", { name: "Transfers" });

async function nearby(browser: Browser, device: string) {
  const opened = await deviceContext(browser, device, { hasTouch: false });
  await opened.page.getByRole("link", { name: "Nearby" }).click();
  await expect(opened.page.getByRole("heading", { name: "Nearby", level: 1 })).toBeVisible();
  return opened;
}

test("sends files and text between your own devices", async ({ browser }) => {
  const ipad = await nearby(browser, "Nearby iPad");
  const iphone = await nearby(browser, "Nearby iPhone");
  try {
    const row = sendTo(ipad.page).getByRole("button", { name: iphone.name, exact: true });
    await expect(row).toHaveAccessibleDescription(/Ready/, { timeout: 20_000 });

    const photo = randomBytes(3 * 1024 * 1024 + 17);
    const note = randomBytes(1000);
    await ipad.page.getByTestId("nearby-file-input").setInputFiles([
      { name: "photo.jpg", mimeType: "image/jpeg", buffer: photo },
      { name: "note.bin", mimeType: "application/octet-stream", buffer: note },
    ]);
    const text = unique("hello");
    await ipad.page.getByRole("button", { name: "Text", exact: true }).click();
    await ipad.page.getByLabel("Text", { exact: true }).fill(text);
    await row.click();

    // Your own devices take it without asking.
    await expect(transfers(ipad.page).getByRole("listitem", { name: `To ${iphone.name}` })).toContainText("Sent", {
      timeout: 30_000,
    });
    const received = transfers(iphone.page).getByRole("listitem", { name: `From ${ipad.name}` });
    await expect(received).toContainText("Received");
    await expect(received.getByRole("list", { name: "Files received" }).getByRole("listitem")).toHaveCount(2);
    await expect(received.locator("pre")).toHaveText(text);
    // Nothing went into Files.
    await expect(iphone.page.getByRole("dialog")).toHaveCount(0);

    const started = iphone.page.waitForEvent("download");
    await received.getByRole("button", { name: "Download photo.jpg" }).click();
    const download = await started;
    expect(download.suggestedFilename()).toBe("photo.jpg");
    expect(sha256(await readFile(await download.path()))).toBe(sha256(photo));

    const zipped = iphone.page.waitForEvent("download");
    await received.getByRole("button", { name: "Download all" }).click();
    expect((await zipped).suggestedFilename()).toMatch(/\.zip$/);
  } finally {
    await ipad.context.close();
    await iphone.context.close();
  }
});

test("trying again takes the stopped transfer's place on both devices", async ({ browser }, testInfo) => {
  const ipad = await nearby(browser, "Nearby iPad");
  const iphone = await nearby(browser, "Nearby iPhone");
  try {
    const row = sendTo(ipad.page).getByRole("button", { name: iphone.name, exact: true });
    await expect(row).toHaveAccessibleDescription(/Ready/, { timeout: 20_000 });
    // Large enough to stop on the way.
    const large = testInfo.outputPath("large.bin");
    await writeFile(large, "");
    await truncate(large, 400 * 1024 ** 2);
    await ipad.page.getByTestId("nearby-file-input").setInputFiles(large);
    await row.click();
    const sent = transfers(ipad.page).getByRole("listitem", { name: `To ${iphone.name}` });
    const received = transfers(iphone.page).getByRole("listitem", { name: `From ${ipad.name}` });
    await expect(received).toBeVisible();
    await sent.getByRole("button", { name: "Cancel" }).click();
    await expect(received).toContainText("stopped sending");

    await sent.getByRole("button", { name: "Try again" }).click();
    await expect(sent).toContainText("Sent", { timeout: 60_000 });
    await expect(received).toContainText("Received");
    await expect(sent).toHaveCount(1);
    await expect(received).toHaveCount(1);
  } finally {
    await ipad.context.close();
    await iphone.context.close();
  }
});

test("someone without an account joins with a code, and asks before sending", async ({ browser }) => {
  const laptop = await nearby(browser, "Nearby laptop");
  const guestContext = await browser.newContext({ hasTouch: false });
  try {
    await sendTo(laptop.page).getByRole("button", { name: "Invite someone" }).click();
    const dialog = laptop.page.getByRole("dialog", { name: "Invite someone" });
    const link = await copyShareUrl(dialog);
    expect(link).toMatch(/\/n\/[\w-]+$/);

    const guest = await guestContext.newPage();
    await guest.goto(link);
    await guest.getByLabel("Your name").fill("Sam");
    await guest.getByRole("button", { name: "Join" }).click();
    await expect(dialog.getByRole("listitem").filter({ hasText: "Sam" })).toContainText("Here now");
    await dialog.getByRole("button", { name: "Done" }).click();

    // A guest is asked about, wherever the member is in Relay.
    await laptop.page.getByRole("link", { name: "Files" }).click();
    const toLaptop = sendTo(guest).getByRole("button", { name: laptop.name, exact: true });
    await expect(toLaptop).toHaveAccessibleDescription(/Ready/, { timeout: 20_000 });
    const data = randomBytes(200_000);
    await guest
      .getByTestId("nearby-file-input")
      .setInputFiles([{ name: "from-sam.bin", mimeType: "application/octet-stream", buffer: data }]);
    await toLaptop.click();
    await expect(transfers(guest).getByRole("listitem", { name: `To ${laptop.name}` })).toContainText("Waiting for");

    const offer = laptop.page.getByRole("dialog", { name: /Sam wants to send you a file/ });
    await expect(offer).toContainText("from-sam.bin");
    await offer.getByRole("button", { name: "Accept" }).click();
    await expect(transfers(guest).getByRole("listitem", { name: `To ${laptop.name}` })).toContainText("Sent", {
      timeout: 30_000,
    });
    await laptop.page.getByRole("link", { name: "Nearby" }).click();
    await expect(transfers(laptop.page).getByRole("listitem", { name: "From Sam" })).toContainText("Received");

    // And the other way: the guest decides too.
    const toSam = sendTo(laptop.page).getByRole("button", { name: "Sam", exact: true });
    await laptop.page.getByRole("button", { name: "Text", exact: true }).click();
    await laptop.page.getByLabel("Text", { exact: true }).fill("the wifi password is on the fridge");
    await toSam.click();
    await guest
      .getByRole("dialog", { name: /wants to send you text/ })
      .getByRole("button", { name: "Decline" })
      .click();
    await expect(transfers(laptop.page).getByRole("listitem", { name: "To Sam" })).toContainText("Sam declined.");
    await expect(
      transfers(laptop.page).getByRole("listitem", { name: "To Sam" }).getByRole("button", { name: "Try again" }),
    ).toBeVisible();

    // Ending the code ends Nearby for the guest.
    await sendTo(laptop.page).getByRole("button", { name: "Nearby code" }).click();
    await laptop.page.getByRole("dialog", { name: "Invite someone" }).getByRole("button", { name: "End code" }).click();
    await laptop.page
      .getByRole("dialog", { name: "End this Nearby code?" })
      .getByRole("button", { name: "End code" })
      .click();
    await expect(guest.getByRole("heading", { name: "Nearby has ended" })).toBeVisible();
  } finally {
    await laptop.context.close();
    await guestContext.close();
  }
});
