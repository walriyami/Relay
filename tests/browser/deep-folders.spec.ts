import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { destinations, signedIn, unique } from "./helpers";

test("a folder nested too deep is refused with a plain reason and no Retry", async ({ page }) => {
  // 64 folders inside the picked one: its file sits 66 names deep, past Relay's 64.
  const root = await mkdtemp(join(tmpdir(), "relay-deep-"));
  const top = join(root, unique("deep"));
  const deepest = join(top, ...Array<string>(64).fill("d"));
  await mkdir(deepest, { recursive: true });
  await writeFile(join(deepest, "f.txt"), "hello");
  try {
    await signedIn(page);
    await page.getByTestId("folder-input").setInputFiles(top);
    await destinations(page).getByRole("button", { name: "Save to Files" }).click();
    const transfer = page.locator(".transfer").first();
    await expect(transfer).toContainText("Couldn’t finish");
    await expect(transfer).toContainText("is nested more than 64 levels deep");
    await expect(transfer.getByRole("button", { name: "Retry" })).toHaveCount(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
