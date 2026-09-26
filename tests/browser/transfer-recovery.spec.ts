import { test, expect } from "@playwright/test";
import { composer, fileInput, signedIn, textFile, unique, destinations, writeText } from "./helpers";

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test("cancelling a transfer with text keeps it in Files and offers view and delete", async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/uploads/**", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await held;
    await route.abort().catch(() => {});
  });

  const name = unique("cancel-text");
  const note = `kept note ${name}`;
  await fileInput(page).setInputFiles([
    { name: `${name}.bin`, mimeType: "application/octet-stream", buffer: Buffer.alloc(1024 * 1024, 7) },
  ]);
  await writeText(page, note);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();

  const card = page.locator(".transfer").first();
  await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card).toContainText("Cancelled · Part of it was kept in Files");
  await expect(card.getByRole("button", { name: "View them" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Delete them" })).toBeVisible();

  await card.getByRole("button", { name: "View them" }).click();
  await expect(page.getByRole("dialog").getByRole("region", { name: "Text" })).toContainText(note);
  release();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a rejected create can be retried with the same id and manifest", async ({ page }) => {
  const creates: Array<Record<string, unknown>> = [];
  await page.route("**/api/transfers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creates.push(route.request().postDataJSON() as Record<string, unknown>);
    if (creates.length === 1)
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "A temporary create conflict." }),
      });
    return route.continue();
  });

  const name = unique("retry-create");
  await fileInput(page).setInputFiles([textFile(`${name}.txt`, "retry this file")]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  const card = page.locator(".transfer").first();
  await expect(card.getByRole("button", { name: "Retry" })).toBeVisible();
  await card.getByRole("button", { name: "Retry" }).click();
  await expect(card).toContainText("Saved to Files");

  expect(creates).toHaveLength(2);
  expect(creates[1]).toEqual(creates[0]);
});

test("a 409 with Upload-Offset resynchronizes the upload", async ({ page }) => {
  let injected = false;
  let recoveredWithHead = false;
  page.on("request", (request) => {
    if (injected && request.method() === "HEAD" && new URL(request.url()).pathname.startsWith("/uploads/"))
      recoveredWithHead = true;
  });
  await page.route("**/uploads/**", async (route) => {
    if (route.request().method() !== "PATCH" || injected) return route.continue();
    injected = true;
    // Let the server commit the bytes, then simulate the response arriving as an offset conflict.
    const response = await route.fetch();
    const actual = response.headers();
    return route.fulfill({
      status: 409,
      headers: {
        "content-type": "application/json",
        "tus-resumable": actual["tus-resumable"] ?? "1.0.0",
        "upload-length": actual["upload-length"] ?? "0",
        "upload-offset": actual["upload-offset"] ?? "0",
      },
      body: JSON.stringify({ error: "The server accepted the chunk before the response was lost." }),
    });
  });

  const name = unique("offset-recovery");
  await fileInput(page).setInputFiles([
    { name: `${name}.bin`, mimeType: "application/octet-stream", buffer: Buffer.alloc(1024 * 1024, 4) },
  ]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  expect(injected).toBe(true);
  expect(recoveredWithHead).toBe(true);
});

test("cancelling while create's successful response is lost still cancels by transfer id", async ({ page }) => {
  let releaseFirst = () => {};
  const held = new Promise<void>((resolve) => (releaseFirst = resolve));
  let announceFirst!: () => void;
  const firstFetched = new Promise<void>((resolve) => (announceFirst = resolve));
  const creates: Array<Record<string, unknown>> = [];
  const cancels: string[] = [];
  let cancelAttempts = 0;
  await page.route("**/api/transfers/*/cancel", async (route) => {
    if (++cancelAttempts === 1) return route.fulfill({ status: 503, json: { error: "Retry cancellation." } });
    return route.continue();
  });

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/cancel")) cancels.push(url.pathname);
  });
  await page.route("**/api/transfers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creates.push(route.request().postDataJSON() as Record<string, unknown>);
    if (creates.length !== 1) return route.fulfill({ status: 503, json: { error: "Response unavailable." } });
    // The server creates the item, but the browser never receives this successful response.
    await route.fetch();
    announceFirst();
    await held;
    await route.abort().catch(() => {});
  });

  const name = unique("lost-create");
  await fileInput(page).setInputFiles([textFile(`${name}.txt`, "nothing uploaded yet")]);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await firstFetched;
  const card = page.locator(".transfer").first();
  await card.getByRole("button", { name: "Cancel" }).click();
  releaseFirst();

  await expect(card).toContainText("Cancelled · nothing was kept", { timeout: 25_000 });
  await expect.poll(() => cancels.length).toBeGreaterThan(0);
  expect(creates.length).toBeGreaterThanOrEqual(2);
  expect(creates.every((body) => body.id === creates[0].id)).toBe(true);
  expect(cancels[0]).toBe(`/api/transfers/${String(creates[0].id)}/cancel`);
  expect(cancelAttempts).toBe(2);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("cancelling while completion is already committed resolves to success", async ({ page }) => {
  let releaseComplete = () => {};
  const held = new Promise<void>((resolve) => (releaseComplete = resolve));
  let announceComplete!: () => void;
  const completedOnServer = new Promise<void>((resolve) => (announceComplete = resolve));
  let heldFirstResponse = false;
  await page.route("**/api/transfers/*/complete", async (route) => {
    if (route.request().method() !== "POST" || heldFirstResponse) return route.continue();
    heldFirstResponse = true;
    const response = await route.fetch();
    announceComplete();
    await held;
    await route.fulfill({ response });
  });

  const name = unique("cancel-finish");
  await writeText(page, `already complete ${name}`);
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await completedOnServer;
  const card = page.locator(".transfer").first();
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card).toContainText("Saved to Files");
  releaseComplete();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("an unnamed transfer is named from the whole selection and keeps that name", async ({ page }) => {
  // Hold the second file so the item exists on the server with only part of the selection.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let patches = 0;
  await page.route("**/uploads/**", async (route) => {
    if (route.request().method() !== "PATCH" || patches++ === 0) return route.continue();
    await held;
    await route.continue();
  });
  const name = unique("whole");
  await fileInput(page).setInputFiles([
    textFile(`${name}-a.txt`, "first"),
    textFile(`${name}-b.txt`, "second"),
    textFile(`${name}-c.txt`, "third"),
  ]);
  const expected = `${name}-a.txt + 2 more`;
  await expect(composer(page).getByRole("button", { name: `Name: ${expected}` })).toBeVisible();
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  const hero = page.locator(".transfer-hero-name");
  await expect(hero).toHaveText(expected);
  // Recent's card for the upload in progress uses the same name and shows how far along it is.
  const recent = page.getByRole("list", { name: "Recent" });
  await expect(recent.getByRole("button", { name: new RegExp(`^${expected.replace(/[+]/g, "\\+")}`) })).toContainText(
    /Uploading · \d+%/,
  );
  release();
  await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
  await expect(hero).toHaveText(expected);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a 409 without Upload-Offset stays a final file error", async ({ page }) => {
  let attempts = 0;
  await page.route("**/uploads/**", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    attempts++;
    return route.fulfill({ status: 409, json: { error: "Upload belongs to a closed transfer." } });
  });
  await fileInput(page).setInputFiles(textFile(unique("final-conflict") + ".txt"));
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  const card = page.locator(".transfer");
  await expect(card).toContainText("couldn’t upload");
  expect(attempts).toBe(1);
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card).toContainText("Cancelled");
});

test("cancellation can win before the finishing request commits", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const finishing = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/transfers/*/complete", async (route) => {
    started();
    await held;
    return route.continue();
  });
  await writeText(page, unique("cancel-before-complete"));
  await destinations(page).getByRole("button", { name: "Save to Files" }).click();
  await finishing;
  const card = page.locator(".transfer");
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card).toContainText("Cancelled · Part of it was kept in Files");
  const result = page.waitForResponse((response) => response.url().endsWith("/complete"));
  release();
  expect((await result).status()).toBe(410);
  await expect(card).toContainText("Cancelled · Part of it was kept in Files");
});
