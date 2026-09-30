// Verifies the browser at scale: Chromium picks a generated folder of 10,000 real files through the
// Send page's folder picker and saves it to Files against a disposable local Relay process. The
// page must stay bounded while it works (DOM size independent of the file count, no page errors),
// and afterwards every saved path and every payload hash (via the streaming ZIP) must match disk.
//
// Usage: npm run verify:browser-scale -- [--files 10000] [--use-dist] [--headed]
//   --use-dist serves the existing ./dist instead of building the client into the temp directory.
// Quick run: npm run verify:browser-scale -- --files 300
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { buildClient, cleanUp } from "./lib/verification.ts";
import { chromium, expect } from "@playwright/test";
import { api, urls } from "../shared/api.ts";
import {
  LOCAL_PASSWORD,
  REPO,
  Session,
  assert,
  folderFixture,
  freePort,
  parentsOf,
  readZip,
  sha256,
  sleep,
  startServer,
  stepper,
  type LocalServer,
  errorStack,
} from "./lib/relay.ts";

const { values: flags } = parseArgs({
  options: {
    files: { type: "string", default: "10000" },
    "use-dist": { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
  },
});
const count = Number(flags.files);
assert(Number.isInteger(count) && count > 0, "--files must be a positive integer.");
/** Extra DOM elements the page may add while a transfer runs, whatever its size. */
const DOM_BUDGET = 1_500;

const work = await mkdtemp(join(tmpdir(), "relay-verify-browser-"));
const log = join(work, "server.log");
const { step, timings } = stepper();
const facts: Record<string, unknown> = { files: count };
let server: LocalServer | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  browser = await chromium.launch({ headless: !flags.headed });
  const fixture = folderFixture("browser-scale", count);
  await step(`write ${count} fixture files`, async () => {
    for (const dir of new Set(fixture.map((f) => dirname(f.path))))
      await mkdir(join(work, "fixture", dir), { recursive: true });
    for (let i = 0; i < fixture.length; i += 256)
      await Promise.all(fixture.slice(i, i + 256).map((f) => writeFile(join(work, "fixture", f.path), f.data)));
  });

  const app = flags["use-dist"] ? REPO : join(work, "app");
  if (!flags["use-dist"])
    await step("build the client", () => {
      buildClient(REPO, join(app, "dist"));
    });
  server = await startServer({ root: join(work, "data"), port: await freePort(), cwd: app, log });

  const context = await browser.newContext({ baseURL: server.origin });
  const signIn = await context.request.post(api.session.password.path, {
    data: { username: "admin", password: LOCAL_PASSWORD, deviceName: "Browser scale verification" },
  });
  assert(signIn.ok(), `Sign-in failed with ${signIn.status()}.`);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("crash", () => errors.push("The page crashed."));
  await page.goto("/");
  const composer = page.getByRole("region", { name: "Compose" });
  await expect(composer).toBeVisible();
  const domSize = () => page.evaluate(() => document.getElementsByTagName("*").length);
  const baseline = await domSize();

  await step(`select the ${count}-file folder`, async () => {
    await page.getByTestId("folder-input").setInputFiles(join(work, "fixture", "browser-scale"));
    const rows = page.getByRole("list", { name: "Selected items" }).getByRole("listitem");
    await expect(rows).toHaveCount(1, { timeout: 120_000 });
    await expect(rows.first()).toContainText("Folder");
    facts.domAfterSelect = (await domSize()) - baseline;
  });

  await step("save to Files and watch progress", async () => {
    await page.getByRole("complementary", { name: "Send to" }).getByRole("button", { name: "Save to Files" }).click();
    const card = page.locator(".transfer").first();
    const deadline = Date.now() + 60 * 60_000;
    let maxDom = Number(facts.domAfterSelect);
    const progress = new Set<string>();
    while (!(await card.textContent({ timeout: 1_000 }).catch(() => ""))?.includes("Saved to Files")) {
      assert(Date.now() < deadline, "The transfer did not finish within an hour.");
      assert(!errors.length, `The page reported errors: ${errors.join("; ")}`);
      maxDom = Math.max(maxDom, (await domSize()) - baseline);
      const pct = await card
        .locator(".transfer-pct")
        .first()
        .textContent({ timeout: 1_000 })
        .catch(() => null);
      if (pct) progress.add(pct.trim());
      await sleep(250);
    }
    facts.maxExtraDomElements = maxDom;
    facts.progressValues = [...progress];
    const intermediate = [...progress].some((p) => Number.parseInt(p) > 0 && Number.parseInt(p) < 100);
    assert(intermediate || progress.size > 0, "No progress was shown while sending.");
    assert(maxDom < DOM_BUDGET, `The page grew by ${maxDom} elements while sending (budget ${DOM_BUDGET}).`);
    assert(!errors.length, `The page reported errors: ${errors.join("; ")}`);
  });

  await step("server saved every path and every payload", async () => {
    const session = new Session(server!.origin);
    for (const cookie of await context.cookies()) session.cookies.set(cookie.name, cookie.value);
    const { items } = await session.call(api.items.list, { query: { view: "library" } });
    assert(
      items.length === 1 && items[0].files === count,
      `Expected one item of ${count} files, found ${JSON.stringify(items.map((i) => i.files))}.`,
    );
    const detail = await session.call(api.items.get, { params: { id: items[0].id } });
    const want = new Map(fixture.map((f) => [f.path, sha256(f.data)]));
    const folders = parentsOf(fixture.map((f) => f.path));
    for (const node of detail.nodes)
      assert(
        node.kind === "folder" ? folders.has(node.path) : want.has(node.path),
        `Unexpected saved path ${node.path}.`,
      );
    assert(
      detail.nodes.length === want.size + folders.size,
      `Saved ${detail.nodes.length} nodes, expected ${want.size + folders.size}.`,
    );
    const res = await session.fetch(urls.itemZip(items[0].id));
    const entries = await readZip(res.body as unknown as AsyncIterable<Uint8Array>);
    const files = entries.filter((e) => !e.folder);
    assert(files.length === want.size, `The ZIP holds ${files.length} files, expected ${want.size}.`);
    assert(new Set(files.map((e) => e.path)).size === want.size, "ZIP contains duplicate file paths.");
    for (const entry of files) assert(want.get(entry.path) === entry.sha256, `Wrong payload saved for ${entry.path}.`);
  });

  console.log(JSON.stringify({ passed: true, ...facts, timings }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(`\nverify-browser-scale failed: ${errorStack(error)}`);
  console.error(JSON.stringify(facts, null, 2));
  try {
    console.error(
      `--- last server log lines ---\n${readFileSync(log, "utf8").trim().split("\n").slice(-20).join("\n")}`,
    );
  } catch {
    // No log was written.
  }
} finally {
  if (
    await cleanUp([
      { name: "browser-scale browser", run: () => browser?.close() },
      { name: "browser-scale server", run: () => server?.stop("SIGTERM") },
      { name: "browser-scale directory", run: () => rm(work, { recursive: true, force: true }) },
    ])
  )
    process.exitCode = 1;
}
