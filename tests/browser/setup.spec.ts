import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
 * at all, so there is no account, no address and no secret yet.
 */
async function firstStart() {
  const root = await mkdtemp(join(tmpdir(), "relay-first-start-"));
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const server: ChildProcess = spawn(process.execPath, ["server/main.ts"], {
    env: { PATH: process.env.PATH, RELAY_DATA: root, PORT: String(port), HOST: "localhost" },
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
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(heading(page, "What everyone gets")).toBeVisible();
}

test("a first start goes from welcome to the first invitation, then into Relay", async ({ page }) => {
  await page.goto(relay.url);
  await expect(heading(page, "Welcome to Relay")).toBeVisible();
  await createAccount(page);

  await page.getByRole("radiogroup", { name: "Space for each person" }).getByRole("radio", { name: "50 GB" }).click();
  await page.getByRole("radiogroup", { name: "Empty Trash after" }).getByRole("radio", { name: "90 days" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(heading(page, "Bring your people in")).toBeVisible();
  await page.getByRole("button", { name: "Create an invitation" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your invitation is ready" })).toBeVisible();
  await expect(page.getByRole("img", { name: "QR code for this invitation" })).toBeInViewport();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(heading(page, "You’re all set")).toBeVisible();
  await page.getByRole("button", { name: "Start using Relay" }).click();
  await expect(composer(page)).toBeVisible();
  await expect(page).toHaveURL(`${relay.url}/`);

  // What was chosen is what new members get, and the administrator has it too.
  const overview = await (await page.request.get(`${relay.url}${api.admin.overview.path}`)).json();
  expect(overview.defaults).toMatchObject({ quota: 50 * GIB, trashDays: 90 });
  const me = await (await page.request.get(`${relay.url}${api.session.get.path}`)).json();
  expect(me.user).toMatchObject({ username: "ada", admin: true, quota: 50 * GIB, trashDays: 90 });
  expect(await (await page.request.get(`${relay.url}${api.admin.invites.path}`)).json()).toHaveLength(1);

  // Setup is over: a reload opens Relay, not setup.
  await page.reload();
  await expect(composer(page)).toBeVisible();
});

test("closing the tab after creating the account picks up where it left off", async ({ page, browser }) => {
  await createAccount(page);
  await page.reload();
  await expect(heading(page, "What everyone gets")).toBeVisible();
  await expect(page.getByText("Welcome back. Your account is ready; a few choices are left.")).toBeVisible();

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
  await page.getByRole("button", { name: "I’ll do this later" }).click();
  await expect(heading(page, "You’re all set")).toBeVisible();
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
