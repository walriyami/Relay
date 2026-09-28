import { test, expect, type Page } from "@playwright/test";
import type { AdminOverview, ItemDetail, Link, Me, UploadRequest } from "../../shared/model";
import { signedIn } from "./helpers";

const DAY = 86_400_000;
const GB = 1024 ** 3;
const itemFixture = (now: number, patch: Partial<ItemDetail> = {}): ItemDetail => ({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Lifecycle files",
  autoName: false,
  created: now - DAY,
  firstSavedAt: now - DAY,
  maxAgeDays: 4,
  hardExpires: now + 3 * DAY,
  expires: now + DAY,
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
  linked: false,
  uploading: false,
  nodes: [],
  links: [],
  ...patch,
});

async function displayedDate(page: Page, at: number) {
  return page.evaluate(
    (n) =>
      new Date(n).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    at,
  );
}

async function openRetention(page: Page, item: ItemDetail) {
  await signedIn(page);
  await page.goto(`/files/${item.id}`);
  const details = page.getByRole("dialog", { name: item.name, exact: true });
  await details.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to Trash after…", exact: true }).click();
  return page.getByRole("dialog", { name: "Move to Trash after", exact: true });
}

async function openItemLinkSettings(page: Page, now: number, deadline: "link" | "item" = "link") {
  await page.clock.install({ time: now });
  await page.route("**/api/events?*", (route) => route.abort());
  const item = itemFixture(now, { expires: now + (deadline === "item" ? 10_000 : DAY), linked: true });
  const link: Link = {
    id: "expiring-link",
    itemId: item.id,
    item: { ...item },
    token: "expiring-token",
    code: "123456",
    created: now,
    expires: deadline === "link" ? now + 10_000 : null,
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
  await signedIn(page);
  await page.goto(`/files/${item.id}`);
  await page
    .getByRole("dialog", { name: item.name, exact: true })
    .getByRole("button", { name: "Share", exact: true })
    .click();
  await page.getByRole("button", { name: "Link settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Link settings", exact: true });
  await expect(dialog).toBeVisible();
  return { dialog, link };
}

test("renewal choices respect the hard deadline and report the server-saved expiry", async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  let item = itemFixture(now);
  let requested: unknown;
  const savedExpiry = now + 2 * DAY;
  await page.route(`**/api/items/${item.id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      requested = route.request().postDataJSON();
      item = { ...item, expires: savedExpiry };
    }
    await route.fulfill({ json: item });
  });
  const dialog = await openRetention(page, item);
  await expect(dialog).toContainText("including time in Trash");
  await expect(dialog.getByRole("radio", { name: "Never", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: "7 days", exact: true })).toHaveCount(0);
  await dialog.getByRole("radio", { name: /^Until / }).click();
  const savedLabel = await displayedDate(page, savedExpiry);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(`Moves to Trash on ${savedLabel}`, { exact: true })).toBeVisible();
  expect(requested).toEqual({ retentionDays: 3 });
});

test("pending items explain the first-save clock and expired items cannot renew", async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  let item = itemFixture(now, { firstSavedAt: null, expires: null, hardExpires: null, uploading: true });
  let writes = 0;
  await page.route(`**/api/items/${item.id}`, async (route) => {
    if (route.request().method() !== "GET") writes++;
    await route.fulfill({ json: item });
  });
  let dialog = await openRetention(page, item);
  await expect(dialog).toContainText("The clock starts when the first content is saved.");
  await expect(dialog).not.toContainText("Kept until you delete it");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  item = itemFixture(now, { expires: now - 1 });
  await page.reload();
  await page
    .getByRole("dialog", { name: item.name, exact: true })
    .getByRole("button", { name: "More actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Move to Trash after…", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Move to Trash after", exact: true });
  await expect(dialog).toContainText("This item has expired and cannot be renewed.");
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect(writes).toBe(0);
});

test("link settings bound duration to the item and report the saved expiry with password changes", async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  const item = itemFixture(now, { expires: now + 3 * DAY });
  let link: Link = {
    id: "lifecycle-link",
    itemId: item.id,
    item,
    token: "lifecycle-token",
    code: "123456",
    created: now,
    expires: now + DAY,
    revoked: false,
    available: true,
    full: false,
    locked: false,
    visitorLimit: 1,
    note: "",
    visitors: 2,
    downloads: 1,
    lastVisit: now,
  };
  let requested: unknown;
  const savedExpiry = now + 2 * DAY;
  await page.route("**/api/links", (route) => route.fulfill({ json: [link] }));
  await page.route(`**/api/links/${link.id}`, async (route) => {
    requested = route.request().postDataJSON();
    link = { ...link, expires: savedExpiry, locked: true };
    await route.fulfill({ json: link });
  });
  await signedIn(page);
  await page.getByRole("link", { name: "Links", exact: true }).click();
  await expect(page.getByText(/Opened by 2 browsers/)).toBeVisible();
  await page.getByRole("button", { name: `More actions for ${item.name}` }).click();
  await page.getByRole("menuitem", { name: "Link settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Link settings", exact: true });
  await expect(dialog).toContainText("Visitors are recognised by browser cookies.");
  await expect(dialog).toContainText("previously admitted browsers keep access");
  await expect(dialog).toContainText("Downloads already started may finish.");
  await expect(dialog.getByRole("radio", { name: "Never", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: "7 days", exact: true })).toHaveCount(0);
  await dialog.getByRole("radio", { name: /^Until / }).click();
  await dialog.getByRole("switch", { name: /^Password/ }).click();
  await dialog.getByLabel("Link password", { exact: true }).fill("Saved-expiry-password");
  const savedLabel = await displayedDate(page, savedExpiry);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Password changed\. Expires on/)).toContainText(savedLabel);
  expect(requested).toEqual({ days: 3, password: "Saved-expiry-password" });
});

for (const deadline of ["link", "item"] as const) {
  test(`Files share settings closes at the ${deadline} deadline without a live event`, async ({ page }) => {
    const { dialog } = await openItemLinkSettings(page, Date.now(), deadline);
    await page.clock.fastForward(11_000);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy link", exact: true })).toHaveCount(0);
    await expect(page.getByText("This link has expired.", { exact: true })).toBeVisible();
  });
}

test("a settings submission after its deadline cannot send a stale save", async ({ page }) => {
  const now = Date.now();
  const { dialog, link } = await openItemLinkSettings(page, now);
  let writes = 0;
  await page.route(`**/api/links/${link.id}`, (route) => {
    writes++;
    return route.fulfill({ json: link });
  });
  await dialog.getByRole("switch", { name: /^Password/ }).click();
  await dialog.getByLabel("Link password", { exact: true }).fill("Expired-save-password");
  // Change wall time without running the expiry timer: Save must check the deadline itself.
  await page.clock.setSystemTime(now + 11_000);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("This link is no longer available.", { exact: true })).toBeVisible();
  expect(writes).toBe(0);
});

test("a delayed settings save cannot promise access after the item deadline", async ({ page }) => {
  const now = Date.now();
  const { dialog, link } = await openItemLinkSettings(page, now, "item");
  let finish!: () => void;
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route(`**/api/links/${link.id}`, async (route) => {
    await released;
    await route.fulfill({ json: { ...link, locked: true } });
  });
  await dialog.getByRole("switch", { name: /^Password/ }).click();
  await dialog.getByLabel("Link password", { exact: true }).fill("Delayed-save-password");
  const submitted = page.waitForRequest(`**/api/links/${link.id}`);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await submitted;
  await page.clock.fastForward(11_000);
  finish();
  await expect(page.getByText("Password changed. This link has expired.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Password changed\. Works until you turn it off/)).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
});

test("an open request draft reconciles a live link cap in its choice, preview, and submission", async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
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
  let linkDays: number | null = null;
  await page.route("**/api/session", async (route) => {
    const me = (await (await route.fetch()).json()) as Me;
    await route.fulfill({ json: { ...me, user: { ...me.user, limits: { ...me.user.limits, linkDays } } } });
  });
  let submitted: unknown;
  await page.route("**/api/requests", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: [] });
    const body = route.request().postDataJSON();
    submitted = body;
    const request: UploadRequest = {
      id: body.id,
      name: body.name,
      description: body.description,
      maxBytes: body.maxBytes,
      token: "capped-request",
      code: "123456",
      created: now,
      expires: now + DAY,
      closed: false,
      receivedFiles: 0,
      receivedBytes: 0,
      usedBytes: 0,
      activeBytes: 0,
      trashBytes: 0,
      pendingBytes: 0,
      full: false,
      lastReceived: null,
    };
    await route.fulfill({ json: request });
  });
  const refreshCap = () =>
    page.evaluate(() =>
      (window as unknown as { testSource: EventTarget }).testSource.dispatchEvent(
        new MessageEvent("change", { data: JSON.stringify({ topics: ["account"] }) }),
      ),
    );
  await signedIn(page);
  await page.goto("/requests");
  await page.getByRole("button", { name: "New request", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "New request", exact: true });
  await dialog.getByRole("textbox", { name: "What are you asking for?", exact: true }).fill("Preserved request draft");
  await dialog.getByRole("radio", { name: "30 days", exact: true }).click();
  linkDays = 1;
  await refreshCap();
  await expect(dialog.getByRole("radio", { name: "30 days", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: "1 day", exact: true })).toBeChecked();
  const expected = await page.evaluate(
    (at) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    now + DAY,
  );
  await expect(dialog).toContainText(`Closes ${expected}.`);
  await expect(dialog.getByRole("textbox", { name: "What are you asking for?", exact: true })).toHaveValue(
    "Preserved request draft",
  );
  // A later relaxation offers longer choices but must not silently lengthen this draft again.
  linkDays = null;
  await refreshCap();
  await expect(dialog.getByRole("radio", { name: "30 days", exact: true })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "1 day", exact: true })).toBeChecked();
  await expect(dialog).toContainText(`Closes ${expected}.`);
  await dialog.getByRole("button", { name: "Create request", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(submitted).toMatchObject({ name: "Preserved request draft", days: 1 });
});

test("request expiry ends editing and retained quota links to Files and Trash", async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  const request: UploadRequest = {
    id: "lifecycle-request",
    token: "test-token",
    code: "123456",
    name: "Lifecycle request",
    description: "",
    created: now,
    expires: now + 60_000,
    closed: false,
    maxBytes: 100,
    receivedFiles: 1,
    receivedBytes: 60,
    usedBytes: 100,
    activeBytes: 40,
    trashBytes: 20,
    pendingBytes: 40,
    full: true,
    lastReceived: now,
  };
  await page.route("**/api/requests", (route) => route.fulfill({ json: [request] }));
  await page.route(`**/api/requests/${request.id}/submissions`, (route) => route.fulfill({ json: [] }));
  await signedIn(page);
  await page.getByRole("link", { name: "Requests", exact: true }).click();
  await page.getByRole("button", { name: `More actions for ${request.name}` }).click();
  await page.getByRole("menuitem", { name: "Edit request", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Edit request", exact: true })).toBeVisible();
  await page.clock.fastForward(61_000);
  await expect(page.getByRole("dialog", { name: "Edit request", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: `More actions for ${request.name}` }).click();
  await expect(page.getByRole("menuitem", { name: /Edit request|Reopen/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Create new request" })).toBeVisible();
  await page.getByRole("menuitem", { name: "View received files" }).click();
  const dialog = page.getByRole("dialog", { name: request.name, exact: true });
  await expect(dialog).toContainText("40 B active · 20 B in Trash or expired · 40 B reserved of 100 B.");
  await expect(dialog).toContainText("This request has expired and cannot reopen.");
  await expect(dialog.getByRole("link", { name: "Files", exact: true })).toHaveAttribute("href", "/files");
  await expect(dialog.getByRole("link", { name: "Trash", exact: true })).toHaveAttribute("href", "/trash");
  await dialog.getByRole("button", { name: "New request", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New request", exact: true })).toBeVisible();
});

test("live capacity changes preserve the draft and require rebasing before a compare-and-set save", async ({
  page,
}) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  // Keep refreshes deterministic, and let the periodic admin snapshot deliver the remote edit.
  await page.route("**/api/events?*", (route) => route.abort());
  let capacity = 10 * GB;
  let overview: AdminOverview | undefined;
  const writes: unknown[] = [];
  await page.route("**/api/admin", async (route) => {
    overview ??= (await (await route.fetch()).json()) as AdminOverview;
    await route.fulfill({ json: { ...overview, limits: { ...overview.limits, capacity } } });
  });
  await page.route("**/api/admin/settings", async (route) => {
    const body = route.request().postDataJSON() as { capacity: number; expectedCapacity: number };
    writes.push(body);
    capacity = body.capacity;
    await route.fulfill({ json: { ok: true } });
  });
  await signedIn(page);
  await page.goto("/admin/settings");
  const input = page.getByRole("spinbutton", { name: /^Total storage/ });
  await expect(input).toHaveValue("10");
  await input.fill("8");
  capacity = 6 * GB;
  await page.clock.fastForward(31_000);
  await expect(page.getByText(/Total storage changed to 6 GB\. Your draft is preserved\./)).toBeVisible();
  await expect(input).toHaveValue("8");
  await page.getByRole("button", { name: "Save total storage", exact: true }).click();
  await expect(
    page.getByText("Total storage changed. Review the current capacity before saving your draft."),
  ).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Use my draft with this current capacity" }).click();
  await page.getByRole("button", { name: "Save total storage", exact: true }).click();
  await expect(page.getByText("Total storage saved", { exact: true })).toBeVisible();
  expect(writes).toEqual([{ capacity: 8 * GB, expectedCapacity: 6 * GB }]);
});

test("a rejected invitation policy save preserves its draft and rebases the next compare-and-set", async ({ page }) => {
  let limits = { storage: null, keepDays: 30, linkDays: 30 };
  const original = { ...limits };
  const writes: { limits: typeof limits; expectedLimits: typeof limits }[] = [];
  const now = Date.now();
  await page.route("**/api/admin/invites", (route) =>
    route.fulfill({
      json: [
        {
          id: "lifecycle-invite",
          created: now,
          expires: now + DAY,
          createdBy: "admin",
          note: "Lifecycle tester",
          code: "123456",
          limits,
        },
      ],
    }),
  );
  await page.route("**/api/admin/invites/lifecycle-invite", async (route) => {
    const body = route.request().postDataJSON() as (typeof writes)[number];
    writes.push(body);
    if (writes.length === 1) {
      limits = { ...limits, keepDays: 90 };
      await route.fulfill({ status: 409, json: { error: "Limits changed while this invitation was open." } });
    } else {
      limits = body.limits;
      await route.fulfill({ json: { ok: true } });
    }
  });
  await signedIn(page);
  await page.goto("/admin/members");
  await page.getByRole("button", { name: "Edit invitation for Lifecycle tester" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit invitation", exact: true });
  const age = dialog.getByRole("radiogroup", { name: "Maximum file age", exact: true });
  await age.getByRole("radio", { name: "7 days", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByText(/Your draft is preserved\. Current limits:/)).toContainText("file age up to 90 days");
  await expect(age.getByRole("radio", { name: "7 days", exact: true })).toBeChecked();
  expect(writes[0].expectedLimits).toEqual(original);
  await dialog.getByRole("button", { name: "Use my draft with these current limits" }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Invitation saved", { exact: true })).toBeVisible();
  expect(writes[1].expectedLimits).toEqual({ ...original, keepDays: 90 });
  expect(writes[1].limits.keepDays).toBe(7);
});
