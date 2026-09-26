import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyShareUrl, recordWrites, signedIn, textFile, unique } from "./helpers";

test("a guest picks files, reviews them, and only uploads on Upload", async ({ page, browser }) => {
  await signedIn(page);
  const name = unique("request");
  await page.getByRole("link", { name: "Requests" }).click();
  await page.getByRole("button", { name: "New request" }).click();
  await page.getByLabel("What are you asking for?").fill(name);
  await page.getByRole("button", { name: "Create request" }).click();
  const url = await copyShareUrl(page.getByRole("dialog"));

  const visitor = await browser.newContext();
  const guest = await visitor.newPage();
  await guest.goto(url);
  await expect(guest.getByText(name).first()).toBeVisible();
  const writes = recordWrites(guest);
  await guest.getByTestId("guest-file-input").setInputFiles([textFile(`${name}-a.txt`)]);
  await guest.getByTestId("guest-file-input").setInputFiles([textFile(`${name}-b.txt`)]);
  await expect(guest.getByRole("button", { name: /^Remove / })).toHaveCount(2);
  await guest.getByRole("button", { name: `Remove ${name}-b.txt` }).click();
  await guest.waitForTimeout(1000);
  expect(writes).toEqual([]);
  await guest.getByRole("button", { name: "Upload 1 file", exact: true }).click();
  await expect(guest.getByRole("heading", { name: "Files sent" })).toBeVisible();
  await expect(guest.getByRole("status").filter({ hasText: "uploaded for admin" })).toBeVisible();
  await visitor.close();

  // The owner finds it under the request.
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByRole("list", { name: "Open requests" })).toContainText(name);
});

/** Creates a request from the Requests page and returns its guest link, leaving the page on Requests. */
async function createRequest(page: Page, name: string) {
  await page.getByRole("link", { name: "Requests" }).click();
  await page.getByRole("button", { name: "New request" }).first().click();
  await page.getByLabel("What are you asking for?").fill(name);
  await page.getByRole("button", { name: "Create request" }).click();
  const url = await copyShareUrl(page.getByRole("dialog"));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return url;
}
const requestRow = (page: Page, name: string) =>
  page.getByRole("list", { name: "Open requests" }).getByRole("listitem").filter({ hasText: name });

test("a full request says so, hides the picker and never offers to send more", async ({ page, browser }) => {
  await signedIn(page);
  const name = unique("full");
  // Three 6-byte files fill it exactly; the form's smallest limit is far larger.
  const session = await (await page.request.get("/api/session")).json();
  const created = await page.request.post("/api/requests", {
    headers: { "X-Relay-CSRF": session.csrf },
    data: { id: crypto.randomUUID(), name, days: 7, maxBytes: 18 },
  });
  const { token } = await created.json();

  const visitor = await browser.newContext();
  const guest = await visitor.newPage();
  await guest.goto(`/r/${token}`);
  await guest
    .getByTestId("guest-file-input")
    .setInputFiles([1, 2, 3, 4].map((n) => textFile(`${name}-${n}.txt`, `file ${n}`)));
  await expect(guest.getByRole("alert")).toHaveText("This request accepts up to 18 B. Remove 6 B to continue.");
  await expect(guest.getByRole("button", { name: "Upload 4 files" })).toBeDisabled();
  await guest.getByRole("button", { name: `Remove ${name}-4.txt` }).click();
  await expect(guest.getByRole("alert")).toHaveCount(0);
  await guest.getByRole("button", { name: "Upload 3 files", exact: true }).click();

  const sent = guest.locator(".guest-sent");
  await expect(sent.getByRole("heading", { name: "Files sent" })).toBeVisible();
  await expect(sent).toContainText("This request is full. admin has received the 18 B it allows.");
  await expect(guest.getByRole("button", { name: "Send more files" })).toHaveCount(0);

  // Coming back later: the same notice, and nothing to pick files with.
  await guest.reload();
  await expect(guest.locator(".guest-full")).toContainText(
    "This request is full. admin has received the 18 B it allows.",
  );
  await expect(guest.getByRole("button", { name: "Add files" })).toHaveCount(0);
  await expect(guest.getByTestId("guest-file-input")).toHaveCount(0);
  await visitor.close();

  // The owner sees it is full; raising the limit is offered, and closing stays in the menu.
  await page.getByRole("link", { name: "Requests" }).click();
  const row = requestRow(page, name);
  await expect(row.locator(".pill")).toHaveText("Full");
  await expect(row.getByRole("button", { name: "Raise limit" })).toBeVisible();
  await page.getByRole("button", { name: `More actions for ${name}` }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Close request" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close request" }).click();
  await expect(page.getByRole("list", { name: "Closed requests" })).toContainText(name);
});

test("a guest keeps identical picks, shows collision names, and labels the submission", async ({ page, browser }) => {
  await signedIn(page);
  const name = unique("guest-name");
  const url = await createRequest(page, name);
  // Waiting on another page: a finished submission is announced with a way to it.
  await page.getByRole("link", { name: "Files" }).click();

  const dir = await mkdtemp(join(tmpdir(), "relay-guest-"));
  const same = join(dir, `${name}-same.txt`);
  await writeFile(same, "identical");

  const visitor = await browser.newContext();
  const guest = await visitor.newPage();
  await guest.goto(url);
  const input = guest.getByTestId("guest-file-input");
  // The very same file twice remains two independent picks.
  await input.setInputFiles(same);
  await input.setInputFiles(same);
  await expect(guest.getByRole("button", { name: /^Remove / })).toHaveCount(2);
  await expect(guest.getByRole("list", { name: "Renamed files" })).toContainText(
    `${name}-same.txt will be saved as ${name}-same (2).txt`,
  );
  // Two different files with one name: the guest is told how the second will be saved.
  await input.setInputFiles([textFile(`${name}-a.txt`, "one")]);
  await input.setInputFiles([textFile(`${name}-a.txt`, "two!")]);
  await expect(guest.getByRole("button", { name: /^Remove / })).toHaveCount(4);
  await expect(guest.getByRole("list", { name: "Renamed files" })).toContainText(
    `${name}-a.txt will be saved as ${name}-a (2).txt`,
  );

  await guest.getByLabel("Your name (optional)").fill("  Dana  ");
  await guest.getByRole("button", { name: "Upload 4 files", exact: true }).click();
  await expect(guest.getByRole("heading", { name: "Files sent" })).toBeVisible();
  await visitor.close();

  const notice = page.locator(".toast", { hasText: `New files for ${name}` });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "View" }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const dialog = page.getByRole("dialog", { name: name });
  const submission = dialog.locator(".submission-row").first();
  await expect(submission.locator("strong")).toHaveText(`${name} · Dana`);
  await expect(submission).toContainText("From Dana");
  await submission.click();
  const item = page.getByRole("dialog").last();
  await expect(item.locator(".tile-name", { hasText: `${name}-a.txt` })).toBeVisible();
  await expect(item.locator(".tile-name", { hasText: `${name}-a (2).txt` })).toBeVisible();
  await expect(item.locator(".tile-name", { hasText: `${name}-same.txt` })).toHaveCount(1);
  await expect(item.locator(".tile-name", { hasText: `${name}-same (2).txt` })).toHaveCount(1);
});

test("a submission without a name is named after its first file", async ({ page, browser }) => {
  await signedIn(page);
  const name = unique("unnamed");
  const url = await createRequest(page, name);
  const visitor = await browser.newContext();
  const guest = await visitor.newPage();
  await guest.goto(url);
  await guest
    .getByTestId("guest-file-input")
    .setInputFiles([textFile(`${name}-W-2.pdf`, "w2"), textFile(`${name}-receipt.txt`, "r")]);
  await guest.getByRole("button", { name: "Upload 2 files", exact: true }).click();
  await expect(guest.getByRole("heading", { name: "Files sent" })).toBeVisible();
  await visitor.close();

  await requestRow(page, name)
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  const submission = page.getByRole("dialog").locator(".submission-row").first();
  await expect(submission.locator("strong")).toHaveText(`${name} · ${name}-W-2.pdf + 1 more`);
  await expect(submission).not.toContainText("From ");

  // In Files it is marked as having come through a request.
  await page.keyboard.press("Escape");
  await page.goto("/files");
  const card = page.getByRole("button", { name: new RegExp(`${name}-W-2\\.pdf.*Received through a request`) });
  await expect(card).toBeVisible();
  await expect(card.locator('.card-badge[title="Received through a request"]')).toBeVisible();
});
