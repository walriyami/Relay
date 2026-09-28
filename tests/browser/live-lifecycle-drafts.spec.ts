import { test, expect, type Page } from "@playwright/test";
import type { ItemDetail, Link, Me } from "../../shared/model";
import { destinations, recordWrites, signedIn, textFile, unique } from "./helpers";

const DAY = 86_400_000;

async function testEvents(page: Page) {
  await page.addInitScript(() => {
    class TestSource extends EventTarget {
      constructor() {
        super();
        (window as unknown as { testSource: EventTarget }).testSource = this;
      }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: TestSource });
  });
}
const refresh = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { testSource: EventTarget }).testSource.dispatchEvent(
      new MessageEvent("change", { data: JSON.stringify({ topics: ["account", "items", "links"] }) }),
    ),
  );

async function expiringRequest(page: Page) {
  const now = Date.now();
  await page.clock.install({ time: now });
  const token = "closing-request";
  await page.route(`**/api/r/${token}`, (route) =>
    route.fulfill({
      json: {
        name: "Closing request",
        owner: "Owner",
        description: "",
        maxBytes: 1024,
        remainingBytes: 1024,
        remainingEntries: 100,
        full: false,
        expires: now + 10_000,
      },
    }),
  );
  const writes = recordWrites(page);
  await page.goto(`/r/${token}`);
  await expect(page.getByRole("heading", { name: "Closing request" })).toBeVisible();
  return { now, writes };
}

test("a visible public request closes at its deadline without a server event", async ({ page }) => {
  const { writes } = await expiringRequest(page);
  await page.getByTestId("guest-file-input").setInputFiles(textFile("waiting.txt"));
  await page.clock.fastForward(11_000);
  await expect(page.getByRole("heading", { name: "Request unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Upload|^Add files/ })).toHaveCount(0);
  await expect(page.getByTestId("guest-file-input")).toHaveCount(0);
  expect(writes).toEqual([]);
});

for (const action of ["upload", "file picker"] as const) {
  test(`a delayed ${action} callback cannot use an expired request`, async ({ page }) => {
    const { now, writes } = await expiringRequest(page);
    if (action === "upload") await page.getByTestId("guest-file-input").setInputFiles(textFile("late.txt"));
    // Wall time changes without running the deadline timer, as when the browser was suspended.
    await page.clock.setSystemTime(now + 11_000);
    if (action === "upload") await page.getByRole("button", { name: "Upload 1 file", exact: true }).click();
    else await page.getByTestId("guest-file-input").setInputFiles(textFile("late.txt"));
    await expect(page.getByRole("heading", { name: "Request unavailable" })).toBeVisible();
    expect(writes).toEqual([]);
  });
}

test("a folder read finishing after request expiry cannot restore the selection", async ({ page }) => {
  const { writes } = await expiringRequest(page);
  await page.evaluate(() => {
    const file = new File(["late"], "late.txt");
    let first = true;
    const directory = {
      name: "folder",
      isDirectory: true,
      isFile: false,
      createReader: () => ({
        readEntries: (resolve: (entries: unknown[]) => void) => {
          if (!first) return resolve([]);
          first = false;
          (window as unknown as { finishFolder: () => void }).finishFolder = () =>
            resolve([
              { name: file.name, isDirectory: false, isFile: true, file: (done: (f: File) => void) => done(file) },
            ]);
        },
      }),
    };
    const event = new DragEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        types: ["Files"],
        items: [{ webkitGetAsEntry: () => directory, getAsFile: () => file }],
      },
    });
    document.dispatchEvent(event);
  });
  await expect(page.getByText("Reading what you dropped…", { exact: true })).toBeVisible();
  await page.clock.fastForward(11_000);
  await page.evaluate(() => (window as unknown as { finishFolder: () => void }).finishFolder());
  await expect(page.getByRole("heading", { name: "Request unavailable" })).toBeVisible();
  await expect(page.getByText("late.txt", { exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("an accepted guest upload stays visible and finishes after the known request deadline", async ({
  page,
  browser,
}) => {
  await signedIn(page);
  const session = await (await page.request.get("/api/session")).json();
  const response = await page.request.post("/api/requests", {
    headers: { "X-Relay-CSRF": session.csrf },
    data: { id: crypto.randomUUID(), name: unique("closing-upload"), days: 1, maxBytes: 1024 },
  });
  expect(response.ok()).toBe(true);
  const request = await response.json();
  const visitor = await browser.newContext();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const guest = await visitor.newPage();
    const now = Date.now();
    await guest.clock.install({ time: now });
    await guest.route(`**/api/r/${request.token}`, async (route) => {
      const current = await (await route.fetch()).json();
      await route.fulfill({ json: { ...current, expires: now + 10_000 } });
    });
    await guest.route("**/uploads/*", async (route) => {
      if (route.request().method() === "PATCH") await pending;
      await route.continue();
    });
    await guest.goto(`/r/${request.token}`);
    await guest.getByTestId("guest-file-input").setInputFiles(textFile("accepted.txt"));
    const uploading = guest.waitForRequest(
      (r) => r.method() === "PATCH" && new URL(r.url()).pathname.startsWith("/uploads/"),
    );
    await guest.getByRole("button", { name: "Upload 1 file", exact: true }).click();
    await uploading;
    await guest.clock.fastForward(11_000);
    await expect(guest.getByRole("heading", { name: "Request unavailable" })).toBeVisible();
    await expect(guest.locator(".transfer-list")).toContainText("accepted.txt");
    await expect(guest.locator(".transfer-list")).toContainText("Uploads already accepted can still finish.");
    release();
    await expect(guest.locator(".transfer-list")).toContainText("Uploaded");
    await expect(guest.getByRole("button", { name: "Send more files", exact: true })).toHaveCount(0);
  } finally {
    release();
    await visitor.close();
  }
});

function itemFixture(now: number, patch: Partial<ItemDetail> = {}): ItemDetail {
  return {
    id: "00000000-0000-4000-8000-000000000090",
    name: "Live policy files",
    autoName: false,
    created: now,
    firstSavedAt: now,
    maxAgeDays: null,
    hardExpires: null,
    expires: null,
    trashed: null,
    purgeAt: null,
    requestId: null,
    files: 0,
    texts: 0,
    folders: 0,
    bytes: 0,
    topFiles: 0,
    topFolders: 0,
    preview: null,
    mosaic: [],
    textExcerpt: null,
    linked: true,
    uploading: false,
    nodes: [],
    links: [],
    ...patch,
  };
}

async function liveSession(page: Page) {
  await testEvents(page);
  const limits = { linkDays: null as number | null, keepDays: null as number | null };
  await page.route("**/api/session", async (route) => {
    const me = (await (await route.fetch()).json()) as Me;
    await route.fulfill({ json: { ...me, user: { ...me.user, limits: { ...me.user.limits, ...limits } } } });
  });
  return limits;
}

async function linkSettings(page: Page) {
  const now = Date.now();
  const limits = await liveSession(page);
  const item = itemFixture(now);
  const link: Link = {
    id: "live-policy-link",
    itemId: item.id,
    item: { ...item },
    token: "live-policy-token",
    code: "123456",
    created: now,
    expires: null,
    revoked: false,
    available: true,
    full: false,
    locked: false,
    visitorLimit: null,
    note: "",
    visitors: 0,
    downloads: 0,
    lastVisit: null,
  };
  item.links = [link];
  await page.route(`**/api/items/${item.id}`, (route) => route.fulfill({ json: item }));
  await page.route("**/api/links", (route) => route.fulfill({ json: [link] }));
  const submitted: unknown[] = [];
  await page.route(`**/api/links/${link.id}`, async (route) => {
    submitted.push(route.request().postDataJSON());
    await route.fulfill({ json: { ...link, expires: now + DAY } });
  });
  await signedIn(page);
  await page.goto(`/files/${item.id}`);
  await page
    .getByRole("dialog", { name: item.name, exact: true })
    .getByRole("button", { name: "Share", exact: true })
    .click();
  await page.getByRole("button", { name: "Link settings", exact: true }).click();
  return { limits, submitted, dialog: page.getByRole("dialog", { name: "Link settings", exact: true }) };
}

for (const selection of ["30 days", "Never"] as const) {
  test(`a chosen ${selection} link duration stays capped after the policy relaxes`, async ({ page }) => {
    const { limits, dialog, submitted } = await linkSettings(page);
    await dialog.getByRole("radio", { name: selection, exact: true }).click();
    limits.linkDays = 1;
    await refresh(page);
    await expect(dialog.getByRole("radio", { name: "1 day", exact: true })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: selection, exact: true })).toHaveCount(0);
    limits.linkDays = null;
    await refresh(page);
    await expect(dialog.getByRole("radio", { name: selection, exact: true })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "1 day", exact: true })).toBeChecked();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect(submitted).toEqual([{ days: 1 }]);
  });
}

test("a policy change does not re-date an existing link when no duration was chosen", async ({ page }) => {
  const { limits, dialog, submitted } = await linkSettings(page);
  limits.linkDays = 1;
  await refresh(page);
  await expect(dialog.getByRole("radio", { name: "30 days", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { checked: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(submitted).toEqual([]);
});

test("a new link draft reconciles even while its settings are closed", async ({ page }) => {
  const limits = await liveSession(page);
  await signedIn(page);
  await page.getByRole("button", { name: "Link settings", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Link settings", exact: true });
  await dialog.getByRole("radio", { name: "30 days", exact: true }).click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  limits.linkDays = 1;
  await refresh(page);
  await expect(destinations(page)).toContainText("Expires in 1 day");
  limits.linkDays = null;
  await refresh(page);
  await page.getByRole("button", { name: "Link settings", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Link settings", exact: true });
  await expect(dialog.getByRole("radio", { name: "30 days", exact: true })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "1 day", exact: true })).toBeChecked();
});

test("an open pending-item dialog keeps its historical age cap as policy relaxes and content saves", async ({
  page,
}) => {
  const now = Date.now();
  const limits = await liveSession(page);
  limits.keepDays = 30;
  let item = itemFixture(now, { firstSavedAt: null, maxAgeDays: 30, uploading: true });
  let submitted: unknown;
  await page.route(`**/api/items/${item.id}`, async (route) => {
    if (route.request().method() === "PATCH") submitted = route.request().postDataJSON();
    await route.fulfill({ json: item });
  });
  await signedIn(page);
  await page.goto(`/files/${item.id}`);
  await page
    .getByRole("dialog", { name: item.name, exact: true })
    .getByRole("button", { name: "More actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Move to Trash after…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Move to Trash after", exact: true });
  await dialog.getByRole("radio", { name: "30 days", exact: true }).click();
  item = { ...item, maxAgeDays: 3 };
  limits.keepDays = 3;
  await refresh(page);
  await expect(dialog).toContainText("Maximum total age is 3 days from the first saved content, including Trash.");
  await expect(dialog.getByRole("radio", { name: "3 days", exact: true })).toBeChecked();
  limits.keepDays = 90;
  await refresh(page);
  await expect(dialog).toContainText("Maximum total age is 3 days");
  await expect(dialog.getByRole("radio", { name: "30 days", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: "Never", exact: true })).toHaveCount(0);
  item = { ...item, firstSavedAt: now, expires: now + 3 * DAY, hardExpires: now + 3 * DAY, uploading: false };
  await refresh(page);
  await expect(dialog).toContainText("Deleted forever by");
  await expect(dialog).not.toContainText("The clock starts when the first content is saved.");
  await expect(dialog.getByRole("radio", { name: /^Until / })).toBeChecked();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect(submitted).toEqual({ retentionDays: 3 });
});
