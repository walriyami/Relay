import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "../../shared/api.ts";
import { composer } from "./helpers";

const GIB = 1024 ** 3;
const PASSWORD = "Browser-test-password-only";

/** A free port on this machine, for a Relay of the test's own. */
function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer().once("error", reject);
    server.listen(0, "localhost", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * Relay started the way a person starts it the first time: an empty data folder and no settings
 * at all, so there is no account, no address and no secret yet. `setupKey` starts it with
 * RELAY_SETUP_KEY, as someone who wants setup guarded would.
 */
async function firstStart({ setupKey = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "relay-first-start-"));
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const server: ChildProcess = spawn(process.execPath, ["server/main.ts"], {
    env: {
      PATH: process.env.PATH,
      RELAY_DATA: root,
      PORT: String(port),
      HOST: "localhost",
      ...(setupKey && { RELAY_SETUP_KEY: "true" }),
    },
    stdio: "ignore",
  });
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (attempt > 150) throw new Error("Relay didn’t start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    url,
    readSetupKey: async () => (await readFile(join(root, "setup.key"), "utf8")).trim(),
    async close() {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await exited;
      await rm(root, { recursive: true, force: true });
    },
  };
}

let relay: Awaited<ReturnType<typeof firstStart>>;
test.beforeEach(async () => {
  relay = await firstStart();
});
test.afterEach(async () => {
  await relay.close();
});

const heading = (page: Page, name: string) => page.getByRole("heading", { level: 1, name });

async function createAccount(page: Page, username = "ada") {
  await page.goto(relay.url);
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(heading(page, "Create your account")).toBeVisible();
  await expect(page.getByLabel("Username")).toBeFocused();
  await expect(
    page.getByLabel("Setup key"),
    "the key is asked for only when the server was started with it",
  ).toHaveCount(0);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(heading(page, "Make it yours")).toBeVisible();
}

/** From the saved choices past devices and invitations, into Relay. */
async function skipToRelay(page: Page) {
  await expect(heading(page, "Add your other devices")).toBeVisible();
  await page.getByRole("button", { name: "I’ll do this later" }).click();
  await expect(heading(page, "Bring your people in")).toBeVisible();
  await page.getByRole("button", { name: "I’ll do this later" }).click();
  await expect(heading(page, "You’re all set")).toBeVisible();
}

test("a first start goes from welcome to the first invitation, then into Relay", async ({ page }) => {
  await page.goto(relay.url);
  await expect(heading(page, "Welcome to Relay")).toBeVisible();
  await createAccount(page);

  // The administrator's own choices, and how much everyone together may store.
  await page.getByLabel("Your name").fill("Ada");
  await page.getByRole("radiogroup", { name: "Links expire after" }).getByRole("radio", { name: "Never" }).click();
  await page.getByRole("radiogroup", { name: "Empty Trash after" }).getByRole("radio", { name: "90 days" }).click();
  await page.getByRole("button", { name: "Change how much Relay can store" }).click();
  const total = page.getByRole("spinbutton", { name: /^Relay can store up to/ });
  await expect(total).toBeFocused();
  await total.fill("50");
  await page.getByRole("combobox", { name: "Relay can store up to unit" }).selectOption({ label: "GB" });
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(heading(page, "Add your other devices")).toBeVisible();
  await page.getByRole("button", { name: "I’ll do this later" }).click();
  await expect(heading(page, "Bring your people in")).toBeVisible();
  await page.getByRole("button", { name: "Create an invitation" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your invitation is ready" })).toBeVisible();
  await expect(page.getByRole("img", { name: "QR code for this invitation" })).toBeInViewport();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(heading(page, "You’re all set")).toBeVisible();
  await page.getByRole("button", { name: "Start using Relay" }).click();
  await expect(composer(page)).toBeVisible();
  await expect(page).toHaveURL(`${relay.url}/`);

  // The choices are the administrator's own; the total is everyone's, and the invitation has no limits.
  const overview = await (await page.request.get(`${relay.url}${api.admin.overview.path}`)).json();
  expect(overview.limits.capacity).toBe(50 * GIB);
  const me = await (await page.request.get(`${relay.url}${api.session.get.path}`)).json();
  expect(me.user).toMatchObject({ username: "ada", name: "Ada", admin: true, trashDays: 90 });
  expect(me.prefs.linkDays).toBeNull();
  const invites = await (await page.request.get(`${relay.url}${api.admin.invites.path}`)).json();
  expect(invites).toHaveLength(1);
  expect(invites[0].limits).toEqual({ storage: null, keepDays: null, linkDays: null });

  // Setup is over: a reload opens Relay, not setup.
  await page.reload();
  await expect(composer(page)).toBeVisible();
});

test("closing the tab after creating the account picks up where it left off", async ({ page, browser }) => {
  await createAccount(page);
  await page.reload();
  await expect(heading(page, "Make it yours")).toBeVisible();
  await expect(page.getByText("Welcome back. A few choices are left.")).toBeVisible();

  // Anyone else who opens Relay meanwhile is asked to sign in; setup isn't theirs to finish.
  const other = await browser.newContext();
  try {
    const visitor = await other.newPage();
    await visitor.goto(relay.url);
    await expect(visitor.getByRole("heading", { name: "Sign in" })).toBeVisible();
  } finally {
    await other.close();
  }

  await page.getByRole("button", { name: "Save and continue" }).click();
  await skipToRelay(page);
});

test("a server started with RELAY_SETUP_KEY asks for its key first, spaced like the fields below it", async ({
  page,
}) => {
  await relay.close();
  relay = await firstStart({ setupKey: true });
  await page.goto(relay.url);
  await page.getByRole("button", { name: "Get started" }).click();
  const key = page.getByLabel("Setup key");
  await expect(key).toBeFocused();
  await expect(page.getByText("from setup.key in its data folder")).toBeVisible();

  // The key sits in the form's own stack, so the gap below it is the gap between every other field.
  const gaps = await page.locator("form.stack > .field").evaluateAll((fields) =>
    fields
      .slice(1)
      // Rounded: Firefox lays fields out at fractions of a pixel.
      .map((field, i) => Math.round(field.getBoundingClientRect().top - fields[i].getBoundingClientRect().bottom)),
  );
  expect(gaps.length).toBeGreaterThanOrEqual(3);
  expect(new Set(gaps).size, `gaps between fields: ${gaps.join(", ")}`).toBe(1);

  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter the setup key.");
  await expect(key).toBeFocused();

  await key.fill("not-the-key");
  await expect(page.getByRole("alert"), "typing clears the complaint").toHaveCount(0);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toHaveText("The setup key is incorrect.");
  await expect(key).toBeFocused();

  await key.fill(await relay.readSetupKey());
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(heading(page, "Make it yours")).toBeVisible();
});

test("a second browser that started setup too is sent to sign in", async ({ page, browser }) => {
  const other = await browser.newContext();
  try {
    const late = await other.newPage();
    await late.goto(relay.url);
    await late.getByRole("button", { name: "Get started" }).click();
    await createAccount(page);

    await late.getByLabel("Username").fill("mallory");
    await late.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await late.getByLabel("Confirm password").fill(PASSWORD);
    await late.getByRole("button", { name: "Create account" }).click();
    await expect(heading(late, "Relay is already set up")).toBeVisible();
    await late.getByRole("button", { name: "Go to sign in" }).click();
    await expect(late.getByRole("heading", { name: "Sign in" })).toBeVisible();
  } finally {
    await other.close();
  }
});

/** Everything that stands for waiting, or only makes sense once there's something: none of it should flash. */
async function watchForFlashes(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as Window & { relaySeen?: string[] }).relaySeen = seen;
    const tick = () => {
      for (const el of document.querySelectorAll<HTMLElement>(".waiting, .toolbar")) {
        if (el.getClientRects().length && Number(getComputedStyle(el).opacity) > 0.02) seen.push(el.className);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return async () => {
    const seen = await page.evaluate(() => (window as Window & { relaySeen?: string[] }).relaySeen!.splice(0));
    return [...new Set(seen)];
  };
}

test("empty pages of a new install appear without a flash of loading, and waiting shows only when it lasts", async ({
  page,
}) => {
  await createAccount(page);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await skipToRelay(page);
  await page.getByRole("button", { name: "Start using Relay" }).click();
  await expect(composer(page)).toBeVisible();
  const flashes = await watchForFlashes(page);
  const nav = (name: string) => page.getByRole("link", { name, exact: true }).first().click();

  // A slow answer shows that it's loading, after a moment…
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/links", async (route) => {
    await held;
    await route.continue();
  });
  await nav("Links");
  await expect(page.locator(".spinner-row")).toHaveCSS("opacity", "1");
  release();
  await expect(page.getByText("No links yet", { exact: true })).toBeVisible();
  await page.unroute("**/api/links");
  await flashes();

  // …a quick one goes straight to the page, with nothing in between…
  for (const [name, empty] of [
    ["Files", "No files yet"],
    ["Requests", "No requests yet"],
  ]) {
    await nav(name);
    await expect(page.getByText(empty, { exact: true })).toBeVisible();
    // A few more frames, for anything that would follow the empty state.
    await page.waitForTimeout(500);
    expect(await flashes(), name).toEqual([]);
  }

  // …and a page seen before shows what it had straight away, even while its refresh is still out.
  await page.route("**/api/links", () => {});
  await nav("Links");
  await expect(page.getByText("No links yet", { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await flashes()).toEqual([]);
});
