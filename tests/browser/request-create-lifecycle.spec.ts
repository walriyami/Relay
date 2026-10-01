import { test, expect, type Page } from "@playwright/test";
import { signedIn, unique } from "./helpers";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

async function draft(page: Page) {
  await signedIn(page);
  await page.getByRole("link", { name: "Requests", exact: true }).click();
  await page.getByRole("button", { name: "New request", exact: true }).click();
  const name = unique("creation-lifecycle");
  const form = page.getByRole("dialog", { name: "New request", exact: true });
  await form.getByLabel("What are you asking for?").fill(name);
  return { name, form };
}
async function holdFirstCreation(page: Page, failAfterCommit = false) {
  const committed = gate();
  const release = gate();
  const ids: string[] = [];
  await page.route("**/api/requests", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    ids.push(route.request().postDataJSON().id as string);
    if (ids.length > 1) return route.continue();
    // The real server has already committed. Only delivery of the response is held/refused.
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    expect((await response.json()).id).toBe(ids[0]);
    committed.open();
    await release.promise;
    if (failAfterCommit)
      await route.fulfill({ status: 503, json: { error: "The creation response was interrupted." } });
    else await route.fulfill({ response });
  });
  return { committed, release, ids };
}
async function finishReply(page: Page, held: Awaited<ReturnType<typeof holdFirstCreation>>) {
  const finished = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/requests") &&
      response.request().method() === "POST" &&
      response.request().postDataJSON().id === held.ids[0],
  );
  held.release.open();
  await (await finished).finished();
  // Let fetch parsing and the resulting React commit paint before asserting absence. An
  // immediate zero-dialog assertion could pass just before the old callback reopens it.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}
const row = (page: Page, name: string) =>
  page.getByRole("list", { name: "Open requests" }).getByRole("listitem").filter({ hasText: name });
async function saved(page: Page, name: string) {
  const response = await page.request.get("/api/requests");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: string; name: string }[]).filter((entry) => entry.name === name);
}

for (const method of ["Cancel", "Close", "Escape", "Back", "Keep open"] as const) {
  test(`${method} during pending creation preserves the record and respects the current dialog`, async ({
    page,
  }, info) => {
    const { name, form } = await draft(page);
    const held = await holdFirstCreation(page);
    try {
      await form.getByRole("button", { name: "Create request", exact: true }).click();
      await held.committed.promise;
      await expect(form.getByRole("button", { name: "Create request", exact: true })).toBeDisabled();
      if (method === "Cancel" || method === "Close")
        await form.getByRole("button", { name: method, exact: true }).click();
      else if (method === "Escape") await page.keyboard.press("Escape");
      else if (method === "Back") await page.goBack();
      if (method !== "Keep open") await expect(form).toHaveCount(0);
      await finishReply(page, held);
      const records = await saved(page, name);
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(held.ids[0]);
      if (method !== "Keep open") {
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(row(page, name)).toBeVisible();
        if (method === "Cancel") await page.screenshot({ path: info.outputPath("dismissed-creation-retained.png") });
        // Closing the form does not remove a successful server record or its later Share action.
        await row(page, name).getByRole("button", { name: "Share", exact: true }).click();
      }
      const handoff = page.getByRole("dialog", { name, exact: true });
      await expect(handoff.getByRole("button", { name: "Copy link", exact: true })).toBeEnabled();
      await handoff.getByRole("button", { name: "Done", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } finally {
      held.release.open();
    }
  });
}

test("a late successful creation cannot close a reopened form or replace its new draft", async ({ page }) => {
  const { name, form } = await draft(page);
  const held = await holdFirstCreation(page);
  try {
    await form.getByRole("button", { name: "Create request", exact: true }).click();
    await held.committed.promise;
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(form).toHaveCount(0);
    await page.getByRole("button", { name: "New request", exact: true }).click();
    const reopened = page.getByRole("dialog", { name: "New request", exact: true });
    const next = unique("new-draft");
    const field = reopened.getByLabel("What are you asking for?");
    await field.fill(next);
    await finishReply(page, held);
    await expect(reopened).toBeVisible();
    await expect(field).toHaveValue(next);
    await expect(field).toBeFocused();
    await expect(page.getByRole("dialog", { name, exact: true })).toHaveCount(0);
    expect(await saved(page, name)).toHaveLength(1);
    await reopened.getByRole("button", { name: "Create request", exact: true }).click();
    const handoff = page.getByRole("dialog", { name: next, exact: true });
    await expect(handoff.getByRole("button", { name: "Copy link", exact: true })).toBeEnabled();
    await handoff.getByRole("button", { name: "Done", exact: true }).click();
    await expect(row(page, name)).toBeVisible();
    await expect(row(page, next)).toBeVisible();
    expect(await saved(page, next)).toHaveLength(1);
  } finally {
    held.release.open();
  }
});

test("a late creation failure cannot add an error to or steal focus from a reopened form", async ({ page }) => {
  const { name, form } = await draft(page);
  const held = await holdFirstCreation(page, true);
  try {
    await form.getByRole("button", { name: "Create request", exact: true }).click();
    await held.committed.promise;
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(form).toHaveCount(0);
    await page.getByRole("button", { name: "New request", exact: true }).click();
    const reopened = page.getByRole("dialog", { name: "New request", exact: true });
    const field = reopened.getByLabel("What are you asking for?");
    const next = unique("draft-after-refusal");
    await field.fill(next);
    await finishReply(page, held);
    await expect(field).toHaveValue(next);
    await expect(field).toBeFocused();
    await expect(reopened.getByRole("alert")).toHaveCount(0);
    await expect(reopened.getByRole("button", { name: "Create request", exact: true })).toBeEnabled();
    expect(await saved(page, name)).toHaveLength(1);
    await reopened.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(row(page, name)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    held.release.open();
  }
});

test("an active creation failure preserves the draft and Retry reuses its successful server record", async ({
  page,
}) => {
  const { name, form } = await draft(page);
  await form.getByLabel("Message (optional)").fill("Preserve this description.");
  const held = await holdFirstCreation(page, true);
  try {
    await form.getByRole("button", { name: "Create request", exact: true }).click();
    await held.committed.promise;
    await finishReply(page, held);
    await expect(form.getByRole("alert")).toHaveText("The creation response was interrupted.");
    await expect(form.getByLabel("What are you asking for?")).toHaveValue(name);
    await expect(form.getByLabel("Message (optional)")).toHaveValue("Preserve this description.");
    await expect(form.getByRole("button", { name: "Create request", exact: true })).toBeEnabled();
    await form.getByRole("button", { name: "Create request", exact: true }).click();
    const handoff = page.getByRole("dialog", { name, exact: true });
    await expect(handoff.getByRole("button", { name: "Copy link", exact: true })).toBeEnabled();
    expect(held.ids).toHaveLength(2);
    expect(held.ids[1]).toBe(held.ids[0]);
    expect(await saved(page, name)).toHaveLength(1);
  } finally {
    held.release.open();
  }
});
