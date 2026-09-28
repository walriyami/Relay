import { expect, request, test } from "@playwright/test";
import { api } from "../../shared/api.ts";
import {
  copyShareUrl,
  BASE,
  composer,
  destinations,
  deviceContext,
  deviceState,
  fileInput,
  textFile,
  unique,
} from "./helpers";

test("a closed member stream retries with the same transfer lease id", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE, storageState: await deviceState("Laptop") });
  const page = await context.newPage();
  const ids: string[] = [];
  await context.route("**/api/events?*", async (route) => {
    ids.push(new URL(route.request().url()).searchParams.get("tab") || "");
    await route.fulfill({ status: 204 });
  });

  try {
    await page.goto("/");
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => ids.length, { timeout: 8000 }).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(1);
  } finally {
    await context.close();
  }
});

test("the next load closes the old tab marker and a persisted pageshow reloads", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE, storageState: await deviceState("Laptop") });
  const page = await context.newPage();
  const oldTab = "01234567abcdef01234567abcdef";
  const closeRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(`/api/tabs/${oldTab}/close`))
      closeRequests.push(request.url());
  });
  await page.addInitScript((tab) => {
    if (!sessionStorage.getItem("relay-live-test-seeded")) {
      sessionStorage.setItem("relay.open-tab", JSON.stringify({ tab, csrf: "" }));
      sessionStorage.setItem("relay-live-test-seeded", "yes");
    }
    const loads = Number(sessionStorage.getItem("relay-live-test-loads") || "0") + 1;
    sessionStorage.setItem("relay-live-test-loads", String(loads));
  }, oldTab);

  try {
    await page.goto("/");
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => closeRequests.length).toBe(1);

    const nextLoad = page.waitForEvent("load");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await nextLoad;
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("relay-live-test-loads"))).toBe("2");
    expect(closeRequests).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("signing into another member in the same tab gets a new lease for its next upload", async ({ browser }) => {
  // Its own client address (the test server trusts the local proxy header), so sign-ins by earlier
  // specs never put this one over the real per-address sign-in limit.
  const context = await browser.newContext({
    baseURL: BASE,
    storageState: await deviceState("Account switch"),
    extraHTTPHeaders: { "X-Forwarded-For": "198.51.100.58" },
  });
  const page = await context.newPage();
  const streamTabs: string[] = [];
  const createTabs: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname === "/api/events") streamTabs.push(url.searchParams.get("tab") || "");
    if (req.method() === "POST" && url.pathname === api.transfers.create.path)
      createTabs.push((req.postDataJSON() as { tab: string }).tab);
  });

  try {
    await page.goto("/");
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => streamTabs.length).toBeGreaterThan(0);
    const adminTab = streamTabs.at(-1)!;

    await page.getByRole("button", { name: "Account: admin" }).click();
    await page.getByRole("menuitem", { name: "Admin" }).click();
    await page.getByRole("button", { name: "Invite member" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
    const inviteUrl = await copyShareUrl(page.getByRole("dialog"));
    const token = new URL(inviteUrl).pathname.split("/").at(-1)!;
    const username = unique("switch").toLowerCase();
    const joinContext = await request.newContext({ baseURL: BASE });
    try {
      const joined = await joinContext.post(api.session.join.path, {
        data: { token, username, password: "Browser-test-password-only", deviceName: "Member device" },
      });
      expect(joined.ok()).toBe(true);
    } finally {
      await joinContext.dispose();
    }

    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Account: admin" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill("Browser-test-password-only");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => new Set(streamTabs).size).toBeGreaterThan(1);
    const memberTab = streamTabs.at(-1)!;
    expect(memberTab).not.toBe(adminTab);

    const name = unique("member-upload");
    await fileInput(page).setInputFiles([textFile(`${name}.txt`, "saved under the new member")]);
    await destinations(page).getByRole("button", { name: "Save to Files" }).click();
    await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
    expect(createTabs).toHaveLength(1);
    expect(createTabs[0]).toBe(memberTab);
  } finally {
    await context.close();
  }
});

test("duplicating an active tab does not copy an abandonment marker", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE, storageState: await deviceState("Laptop") });
  const original = await context.newPage();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let uploading!: () => void;
  const started = new Promise<void>((resolve) => {
    uploading = resolve;
  });
  await original.route("**/uploads/**", async (route) => {
    if (route.request().method() === "PATCH") {
      uploading();
      await held;
    }
    await route.continue();
  });
  try {
    await original.goto("/");
    await expect(composer(original)).toBeVisible();
    await fileInput(original).setInputFiles(textFile(unique("original-lease") + ".txt"));
    await destinations(original).getByRole("button", { name: "Save to Files" }).click();
    await started;
    const storage = await original.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
    expect(storage["relay.open-tab"]).toBeUndefined();
    const duplicate = await context.newPage();
    await duplicate.addInitScript((values) => {
      for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value);
    }, storage);
    const closes: string[] = [];
    duplicate.on("request", (req) => {
      if (req.method() === "POST" && /\/api\/tabs\/[^/]+\/close$/.test(new URL(req.url()).pathname))
        closes.push(req.url());
    });
    await duplicate.goto("/");
    await expect(composer(duplicate)).toBeVisible();
    expect(closes).toEqual([]);
    release();
    await expect(original.locator(".transfer")).toContainText("Saved to Files");
  } finally {
    release();
    await context.close();
  }
});

test("Files to Trash does not flash cards from the previous query", async ({ browser }) => {
  const { context, page } = await deviceContext(browser, "Laptop");
  const name = unique("stale-query");
  let releaseTrash!: () => void;
  const trashResponse = new Promise<void>((resolve) => {
    releaseTrash = resolve;
  });
  let trashRequested = false;
  await page.route("**/api/items?*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.get("view") === "trash") {
      trashRequested = true;
      await trashResponse;
    }
    await route.continue();
  });

  try {
    await fileInput(page).setInputFiles([textFile(`${name}.txt`, "library item")]);
    await destinations(page).getByRole("button", { name: "Save to Files" }).click();
    await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
    await page.getByRole("link", { name: "Files" }).click();
    const files = page.getByRole("list", { name: "Files" });
    await expect(files.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();

    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
    await expect.poll(() => trashRequested).toBe(true);
    const trash = page.getByRole("list", { name: "Trash" });
    await expect(trash.locator('[role="listitem"]').filter({ hasText: name })).toHaveCount(0);
    await expect(trash).toHaveCount(0);
    releaseTrash();
    await expect(trash.locator('[role="listitem"]').filter({ hasText: name })).toHaveCount(0);
  } finally {
    releaseTrash();
    await context.close();
  }
});

test("capacity-limited member tabs retry without spinning and notice revoked sessions", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE, storageState: await deviceState("Laptop") });
  const page = await context.newPage();
  const ids: string[] = [];
  let revoked = false;
  await context.route("**/api/events?*", async (route) => {
    ids.push(new URL(route.request().url()).searchParams.get("tab") || "");
    if (revoked) return route.fulfill({ status: 401, json: { error: "Sign in to continue." } });
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'event: limited\ndata: {"retryMs":500}\n\n',
    });
  });
  await context.route("**/api/session", async (route) => {
    if (revoked) return route.fulfill({ status: 401, json: { error: "Sign in to continue." } });
    return route.continue();
  });
  try {
    await page.goto("/");
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => ids.length).toBeGreaterThanOrEqual(2);
    expect(ids.length).toBeLessThan(5);
    expect(new Set(ids).size).toBe(1);
    revoked = true;
    await expect(page.getByText("Your session ended. Sign in again to continue.")).toBeVisible();
    const stopped = ids.length;
    await page.waitForTimeout(1200);
    expect(ids).toHaveLength(stopped);
  } finally {
    await context.close();
  }
});

test("first-tab admission races converge on the shared stored ID without changing transfer leases", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: BASE, storageState: await deviceState("Laptop") });
  const first = await context.newPage();
  const second = await context.newPage();
  const firstIds: URL[] = [];
  const secondIds: URL[] = [];
  for (const [page, ids] of [
    [first, firstIds],
    [second, secondIds],
  ] as const)
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/events") ids.push(url);
    });
  try {
    await first.goto("/");
    await expect(composer(first)).toBeVisible();
    await expect.poll(() => firstIds.length).toBe(1);
    // Reproduce two first tabs both reading an empty key before the other's write was visible.
    await second.addInitScript(() => {
      // The replacement explicitly preserves the Storage receiver below.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const get = Storage.prototype.getItem;
      let firstRead = true;
      Storage.prototype.getItem = function (key) {
        if (key === "relay.stream-browser" && firstRead) {
          firstRead = false;
          return null;
        }
        return get.call(this, key);
      };
    });
    await second.goto("/");
    await expect(composer(second)).toBeVisible();
    await expect.poll(() => firstIds.length).toBe(2);
    await expect.poll(() => secondIds.length).toBe(1);
    const winner = secondIds[0].searchParams.get("browser");
    expect(winner).toMatch(/^[a-f0-9]{32}$/);
    expect(firstIds[0].searchParams.get("browser")).not.toBe(winner);
    expect(firstIds[1].searchParams.get("browser")).toBe(winner);
    expect(firstIds[1].searchParams.get("tab")).toBe(firstIds[0].searchParams.get("tab"));
    expect(await first.evaluate(() => localStorage.getItem("relay.stream-browser"))).toBe(winner);
  } finally {
    await context.close();
  }
});

for (const unavailable of [false, true]) {
  test(`member and three guest grants leave HTTP/1 capacity for API requests and uploads${unavailable ? " without storage" : ""}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: BASE, storageState: await deviceState("Laptop") });
    if (unavailable)
      await context.addInitScript(() => {
        // The replacement explicitly preserves the Storage receiver below.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const get = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
          if (key === "relay.stream-browser") throw new DOMException("Storage disabled", "SecurityError");
          return get.call(this, key);
        };
      });
    const page = await context.newPage();
    try {
      await page.goto("/");
      await expect(composer(page)).toBeVisible();
      const session = await (await context.request.get(api.session.get.path)).json();
      const tokens: string[] = [];
      for (let index = 0; index < 3; index++) {
        const created = await context.request.post(api.requests.create.path, {
          headers: { "X-Relay-CSRF": session.csrf },
          data: { id: crypto.randomUUID(), name: unique("mixed-grant"), days: 1, maxBytes: 1024 },
        });
        expect(created.ok()).toBe(true);
        const { token } = await created.json();
        tokens.push(token);
        const grant = await context.request.post(`/api/r/${token}/start`, {
          headers: { "X-Relay-CSRF": session.csrf },
        });
        expect(grant.ok()).toBe(true);
      }
      // These are real browser HTTP/1 sockets: the normal member stream plus two per guest grant
      // would occupy the entire pool without a shared admission limit.
      const results = await page.evaluate(
        async ({ tokens, unavailable }) => {
          const browser = unavailable ? null : localStorage.getItem("relay.stream-browser");
          return Promise.all(
            tokens.flatMap((token) =>
              [0, 1].map(
                () =>
                  new Promise<string>((resolve, reject) => {
                    const source = new EventSource(
                      `/api/r/${token}/events?tab=${crypto.randomUUID()}${browser ? `&browser=${browser}` : ""}`,
                    );
                    source.addEventListener("ready", () => resolve("ready"));
                    source.addEventListener("limited", () => {
                      source.close();
                      resolve("limited");
                    });
                    source.addEventListener("error", () => {
                      source.close();
                      reject(new Error("Guest stream failed"));
                    });
                  }),
              ),
            ),
          );
        },
        { tokens, unavailable },
      );
      expect(results.filter((result) => result === "ready")).toHaveLength(unavailable ? 0 : 3);
      expect(results.filter((result) => result === "limited")).toHaveLength(unavailable ? 6 : 3);
      expect(
        await page.evaluate(async () => (await fetch("/api/session", { signal: AbortSignal.timeout(5000) })).status),
      ).toBe(200);
      let patches = 0;
      page.on("request", (request) => {
        if (request.method() === "PATCH") patches++;
      });
      await fileInput(page).setInputFiles(textFile(unique("pool-progress") + ".txt"));
      await destinations(page).getByRole("button", { name: "Save to Files" }).click();
      await expect(page.locator(".transfer").first()).toContainText("Saved to Files");
      expect(patches).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
}

for (const guestFirst of [false, true]) {
  test(`polling members receive deliveries over HTTP/1 ${guestFirst ? "after guests fill every stream slot" : "when shared storage is denied"}`, async ({
    browser,
  }) => {
    const sender = await deviceContext(browser, "Laptop");
    const context = await browser.newContext({
      baseURL: BASE,
      storageState: await deviceState(guestFirst ? "Guest-first receiver" : "Storage-denied receiver"),
    });
    if (!guestFirst)
      await context.addInitScript(() => {
        // The replacement explicitly preserves the Storage receiver below.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const get = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
          if (key === "relay.stream-browser") throw new DOMException("Storage disabled", "SecurityError");
          return get.call(this, key);
        };
      });
    const page = await context.newPage();
    const probes: string[] = [];
    let incomingRefreshes = 0;
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname === "/api/deliveries" && url.searchParams.get("direction") === "incoming" && response.ok())
        incomingRefreshes++;
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/events") probes.push(url.search);
    });
    await page.addInitScript(() => {
      const Native = EventSource;
      const events: string[] = [];
      (window as Window & { relayStreamEvents?: string[] }).relayStreamEvents = events;
      window.EventSource = class extends Native {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          for (const type of ["ready", "limited"]) this.addEventListener(type, () => events.push(type));
        }
      };
    });
    try {
      const senderSession = await (await sender.context.request.get(api.session.get.path)).json();
      const receiverSession = await (await context.request.get(api.session.get.path)).json();
      if (guestFirst) {
        // A same-origin document with no Relay app opens four real HTTP/1 guest sockets first.
        const holder = await context.newPage();
        await holder.goto("/api/health");
        const tokens: string[] = [];
        for (let i = 0; i < 2; i++) {
          const created = await sender.context.request.post(api.requests.create.path, {
            headers: { "X-Relay-CSRF": senderSession.csrf },
            data: { id: crypto.randomUUID(), name: unique("guest-first"), days: 1, maxBytes: 1024 },
          });
          expect(created.ok()).toBe(true);
          const { token } = await created.json();
          tokens.push(token);
          const grant = await context.request.post(`/api/r/${token}/start`, {
            headers: { "X-Relay-CSRF": receiverSession.csrf },
          });
          expect(grant.ok()).toBe(true);
        }
        const ready = await holder.evaluate(async (tokens) => {
          const browser = "a1".repeat(16);
          localStorage.setItem("relay.stream-browser", browser);
          return Promise.all(
            tokens.flatMap((token) =>
              [0, 1].map(
                () =>
                  new Promise<string>((resolve, reject) => {
                    const source = new EventSource(
                      `/api/r/${token}/events?tab=${crypto.randomUUID()}&browser=${browser}`,
                    );
                    source.addEventListener("ready", () => resolve("ready"));
                    source.addEventListener("limited", () => {
                      source.close();
                      reject(new Error("Guest unexpectedly limited"));
                    });
                    source.addEventListener("error", () => {
                      source.close();
                      reject(new Error("Guest stream failed"));
                    });
                  }),
              ),
            ),
          );
        }, tokens);
        expect(ready).toEqual(["ready", "ready", "ready", "ready"]);
      }
      await page.goto("/");
      await expect(composer(page)).toBeVisible();
      const events = () =>
        page.evaluate(() => (window as Window & { relayStreamEvents?: string[] }).relayStreamEvents!);
      await expect.poll(events).toEqual(["limited"]);
      expect(probes).toHaveLength(1);
      expect(new URLSearchParams(probes[0]).has("browser")).toBe(guestFirst);
      // Let both the mount query and the first limited event's debounced refresh finish before
      // creating a delivery. Only the next real probe can then discover it.
      await expect.poll(() => incomingRefreshes).toBeGreaterThanOrEqual(2);
      const destination = destinations(sender.page).getByRole("button", {
        name: receiverSession.device.name,
        exact: true,
      });
      await expect(destination).toBeVisible();
      const name = unique("polled-delivery") + ".txt";
      await fileInput(sender.page).setInputFiles(textFile(name, "delivered while this device polls"));
      const download = page.waitForEvent("download", { timeout: 32_000 });
      await destination.click();
      await expect(sender.page.locator(".transfer").first()).toContainText(`Sent to ${receiverSession.device.name}`);
      // The unchanged limited->ALL topics path discovers the delivery on its next real probe.
      expect((await download).suggestedFilename()).toBe(name);
      await expect(page.getByRole("dialog", { name })).toContainText("Accepted on this device");
      await expect(sender.page.locator(".transfer").first()).toContainText(
        `Accepted on ${receiverSession.device.name}`,
      );
      expect(probes.length).toBeGreaterThanOrEqual(2);
      expect((await events()).every((event) => event === "limited")).toBe(true);
    } finally {
      await context.close();
      await sender.context.close();
    }
  });
}
