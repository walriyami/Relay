// Measures Direct and Nearby transfers the way they run in real life: browsers on devices of their
// own, on a network shaped like Wi-Fi, with phone-sized CPUs, against Relay built from any checkout.
// Numbers from one machine talking to itself say nothing about a phone across a room; these come
// closer. Every device and the server is a container on one Docker network; each shapes what it
// sends (rate, delay, jitter, loss) with the kernel's netem, and a phone's container gets one CPU in
// all, network threads included.
//
//   node scripts/bench-transfers.ts [--source <checkout>] [--label <name>] [--mb 64] [--runs 1]
//     [--profiles lan,good,typical,weak] [--cpus laptop,phone] [--browsers chromium,webkit,firefox]
//     [--scenarios direct-up,direct-down,http-up,http-down,nearby] [--keep]
//
// Needs Docker, with the kernel's netem (Docker Desktop has it). Results go to stdout and, one JSON
// object per line, to bench-results.jsonl.
import { chromium, expect, firefox, webkit, type Browser, type BrowserType, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { api } from "../shared/api.ts";
import type { Me } from "../shared/model.ts";

const { values: args } = parseArgs({
  options: {
    source: { type: "string", default: "." },
    label: { type: "string", default: "current" },
    mb: { type: "string", default: "64" },
    runs: { type: "string", default: "1" },
    profiles: { type: "string", default: "good,typical,weak" },
    cpus: { type: "string", default: "laptop,phone" },
    browsers: { type: "string", default: "chromium" },
    scenarios: { type: "string", default: "direct-up,direct-down,http-up,http-down,nearby" },
    keep: { type: "boolean", default: false },
  },
});

/**
 * Wi-Fi as a device sees it, each way: what it carries in Mbit/s, one-way delay and jitter in ms,
 * and loss that link-layer retries didn't hide, in percent. Wi-Fi retries most losses itself, so what
 * reaches the transport is mostly delay; netem's loss is random, which is harsher than real loss.
 * `lan` is the unshaped Docker network: the most this machine can do, nothing like a real network.
 */
const PROFILES: Record<string, { rate: number; delay: number; jitter: number; loss: number }> = {
  lan: { rate: 0, delay: 0, jitter: 0, loss: 0 },
  good: { rate: 300, delay: 2, jitter: 1, loss: 0.01 },
  typical: { rate: 150, delay: 5, jitter: 3, loss: 0.05 },
  weak: { rate: 40, delay: 15, jitter: 8, loss: 0.3 },
  // "good" with one impairment taken away, to tell which one a result depends on.
  "good-noloss": { rate: 300, delay: 2, jitter: 1, loss: 0 },
  "good-nojitter": { rate: 300, delay: 2, jitter: 0, loss: 0.01 },
  "good-rateonly": { rate: 300, delay: 0, jitter: 0, loss: 0 },
};
/** CPUs a device's whole browser gets: a laptop's all, or one, about a mid-range phone's worth. */
const CPUS: Record<string, number> = { laptop: 0, phone: 1 };
const BROWSERS: Record<string, BrowserType> = { chromium, webkit, firefox };
/** Pages are told their own local addresses, as the network checks need them here. */
const LAUNCH: Record<string, object> = {
  chromium: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] },
  firefox: { firefoxUserPrefs: { "media.peerconnection.ice.obfuscate_host_addresses": false } },
  webkit: {},
};

const ORIGIN = "http://localhost:3091";
const PASSWORD = "Browser-test-password-only";
const NETWORK = "relay-bench";
const SERVER = "relay-bench-server";
const DEVICES = ["relay-bench-a", "relay-bench-b"] as const;
const bench = join(dirname(fileURLToPath(import.meta.url)), "bench");
const MB = Number(args.mb);

const docker = (...argv: string[]) =>
  execFileSync("docker", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 }).trim();
const quietly = (...argv: string[]) => {
  try {
    return docker(...argv);
  } catch {
    return "";
  }
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function shape(container: string, profile: string, share = 1) {
  const p = PROFILES[profile];
  if (!p) throw new Error(`No profile ${profile}.`);
  const env = [`RATE=${Math.round(p.rate * share)}`, `DELAY=${p.delay}`, `JITTER=${p.jitter}`, `LOSS=${p.loss}`];
  docker("exec", ...env.flatMap((e) => ["-e", e]), container, "sh", "/shape.sh");
}

async function start() {
  console.log("Building images…");
  docker("build", "-q", "-t", "relay-bench-device", "-f", join(bench, "device.Dockerfile"), bench);
  const image = `relay-bench-server:${args.label}`;
  docker(
    "build",
    "-q",
    "-t",
    image,
    "-f",
    join(bench, "server.Dockerfile"),
    "--build-context",
    `bench=${bench}`,
    resolve(args.source),
  );
  for (const name of [SERVER, ...DEVICES]) quietly("rm", "-f", name);
  quietly("network", "create", NETWORK);
  docker(
    "run",
    "-d",
    "--name",
    SERVER,
    "--network",
    NETWORK,
    "--network-alias",
    "server",
    "--cap-add",
    "NET_ADMIN",
    image,
  );
  for (const name of DEVICES) {
    docker(
      "run",
      "-d",
      "--name",
      name,
      "--network",
      NETWORK,
      "--cap-add",
      "NET_ADMIN",
      "--shm-size",
      "1g",
      "-v",
      `${join(bench, "shape.sh")}:/shape.sh:ro`,
      "-p",
      "127.0.0.1::4000",
      "relay-bench-device",
    );
  }
  for (const started = Date.now(); ; await sleep(500)) {
    try {
      docker(
        "exec",
        SERVER,
        "node",
        "-e",
        "fetch('http://localhost:3091/api/health').then(r => process.exit(r.ok ? 0 : 1))",
      );
      break;
    } catch {
      if (Date.now() - started > 120_000) throw new Error(`Relay didn't start:\n${quietly("logs", SERVER)}`);
    }
  }
}

function stop() {
  for (const name of [SERVER, ...DEVICES]) quietly("rm", "-f", name);
  quietly("network", "rm", NETWORK);
}

async function connect(device: string, name: string): Promise<Browser> {
  const port = docker("port", device, "4000").split("\n")[0].split(":").pop();
  for (const started = Date.now(); ; await sleep(500)) {
    try {
      return await BROWSERS[name].connect(`ws://127.0.0.1:${port}/`, {
        headers: { "x-playwright-launch-options": JSON.stringify(LAUNCH[name]) },
        timeout: 30_000,
      });
    } catch (error) {
      if (Date.now() - started > 60_000) throw error;
    }
  }
}

/** A signed-in device: its own browser context, as its own named device. */
async function device(browser: Browser, deviceName: string) {
  const context = await browser.newContext({ baseURL: ORIGIN, acceptDownloads: true });
  for (let attempt = 0; ; attempt++) {
    const response = await context.request.post(api.session.password.path, {
      data: { username: "admin", password: PASSWORD, deviceName },
    });
    if (response.ok()) break;
    if (response.status() !== 429 || attempt > 6) throw new Error(`Sign-in failed: ${response.status()}`);
    await sleep(10_000);
  }
  const me = (await (await context.request.get(api.session.get.path)).json()) as Me;
  const page = await context.newPage();
  const lines: string[] = [];
  consoles.set(page, lines);
  page.on("console", (message) => lines.push(`${new Date().toISOString()} ${message.type()} ${message.text()}`));
  page.on("pageerror", (error) => lines.push(`${new Date().toISOString()} pageerror ${String(error)}`));
  await page.goto("/");
  return { context, page, name: me.device.name };
}

const consoles = new WeakMap<Page, string[]>();

/** What each page showed, and logged, when a run failed: in bench-failures/, by time. */
async function snapshot(what: string, pages: Record<string, Page>) {
  const dir = join("bench-failures", `${new Date().toISOString().replace(/[:.]/g, "-")}-${args.label}-${what}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, page] of Object.entries(pages)) {
    const text = await page
      .locator("body")
      .innerText({ timeout: 5000 })
      .catch((e: unknown) => String(e));
    writeFileSync(join(dir, `${name}.txt`), text);
    writeFileSync(join(dir, `${name}-console.txt`), (consoles.get(page) ?? []).join("\n"));
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true }).catch(() => {});
  }
  console.error(`Saved what the pages showed to ${dir}`);
}

/** Bulk requests that went over HTTP rather than directly. */
function overHttp(page: Page) {
  const seen: string[] = [];
  page.on("request", (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.startsWith("/uploads/") || /^\/api\/(nodes|items)\/[^/]+\/(content|zip)$/.test(pathname))
      seen.push(`${req.method()} ${pathname}`);
  });
  return seen;
}

/** Puts a file of random bytes, made in the page itself, in a file input. */
async function pick(page: Page, testId: string, name: string, mb: number) {
  await page.getByTestId(testId).evaluate(
    (input: HTMLInputElement, [name, mb]) => {
      const bytes = new Uint8Array(mb * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: "application/octet-stream" }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [name, mb] as const,
  );
}

const sendTo = (page: Page) => page.getByRole("complementary", { name: "Send to" });
const transfers = (page: Page) => page.getByRole("region", { name: "Transfers" });
let serial = 0;

async function setDirect(page: Page, on: boolean) {
  const button = page.getByRole("button", { name: /^Direct transfers (on|off)$/ });
  await button.waitFor({ timeout: 30_000 });
  const now = (await button.getAttribute("aria-label")) ?? (await button.textContent()) ?? "";
  if (now.includes(on ? " on" : " off")) return;
  await button.click();
  await page
    .getByRole("dialog", { name: "Direct transfers" })
    .getByRole("switch", { name: "Transfer directly" })
    .click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: `Direct transfers ${on ? "on" : "off"}` }).waitFor();
}

async function upload(page: Page, mb: number) {
  const name = `bench-${Date.now()}-${serial++}.bin`;
  await pick(page, "file-input", name, mb);
  const started = performance.now();
  await sendTo(page).getByRole("button", { name: "Save to Files" }).click();
  await page.locator(".transfer", { hasText: name }).getByText("Saved to Files").first().waitFor({ timeout: 900_000 });
  return { name, seconds: (performance.now() - started) / 1000 };
}

async function download(page: Page, name: string) {
  const card = page.getByRole("list", { name: "Recent" }).locator(".collection-card", { hasText: name }).first();
  await card.getByRole("button", { name: /Actions for/ }).click();
  const event = page.waitForEvent("download", { timeout: 60_000 });
  const started = performance.now();
  await page.getByRole("menu").getByRole("menuitem", { name: "Download", exact: true }).click();
  const file = await event;
  const failure = await file.failure();
  if (failure) throw new Error(`Download failed: ${failure}`);
  return (performance.now() - started) / 1000;
}

type Row = {
  label: string;
  scenario: string;
  browser: string;
  profile: string;
  cpu: string;
  mb: number;
  seconds: number[];
  http: number;
  error?: string;
};
const rows: Row[] = [];
function report(row: Row) {
  rows.push(row);
  appendFileSync("bench-results.jsonl", JSON.stringify({ ...row, at: new Date().toISOString() }) + "\n");
  const sorted = [...row.seconds].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const speed = median ? `${(row.mb / median).toFixed(1).padStart(6)} MB/s` : "      —";
  console.log(
    [row.label, row.scenario, row.browser, row.profile, row.cpu].map((s) => s.padEnd(11)).join(" "),
    speed,
    median ? `${median.toFixed(1)} s` : "",
    row.http ? `(${row.http} bulk requests over HTTP)` : "",
    row.error ?? "",
  );
}

async function measure(
  scenario: string,
  browser: string,
  profile: string,
  cpu: string,
  run: () => Promise<{ seconds: number; http: number }>,
) {
  const row: Row = { label: args.label, scenario, browser, profile, cpu, mb: MB, seconds: [], http: 0 };
  try {
    for (let i = 0; i < Number(args.runs); i++) {
      const { seconds, http } = await run();
      row.seconds.push(seconds);
      row.http += http;
    }
  } catch (error) {
    row.error = String(error).split("\n")[0];
  }
  report(row);
}

const list = (value: string | undefined) => (value ?? "").split(",").filter(Boolean);
const scenarios = new Set(list(args.scenarios));

await start();
try {
  for (const browserName of list(args.browsers)) {
    const a = await connect(DEVICES[0], browserName);
    const b = scenarios.has("nearby") ? await connect(DEVICES[1], browserName) : null;
    for (const cpu of list(args.cpus)) {
      for (const name of DEVICES) docker("update", "--cpus", String(CPUS[cpu]), name);
      for (const profile of list(args.profiles)) {
        // Direct and HTTP: the device on Wi-Fi, Relay on the far side of its access point.
        shape(DEVICES[0], profile);
        shape(SERVER, profile);
        const direct = [...scenarios].some((s) => s.startsWith("direct") || s.startsWith("http"));
        if (direct) {
          const laptop = await device(a, `Bench ${browserName} ${cpu} ${profile}`);
          const http = overHttp(laptop.page);
          let uploaded = "";
          for (const mode of ["direct", "http"] as const) {
            if (!scenarios.has(`${mode}-up`) && !scenarios.has(`${mode}-down`)) continue;
            if (mode === "direct") {
              try {
                await setDirect(laptop.page, true);
                // Every lane joins once the first is up.
                await sleep(5000);
              } catch {
                report({
                  label: args.label,
                  scenario: "direct",
                  browser: browserName,
                  profile,
                  cpu,
                  mb: MB,
                  seconds: [],
                  http: 0,
                  error: "never connected",
                });
                continue;
              }
            } else await setDirect(laptop.page, false).catch(() => {});
            const before = () => http.length;
            if (scenarios.has(`${mode}-up`))
              await measure(`${mode}-up`, browserName, profile, cpu, async () => {
                const n = before();
                const result = await upload(laptop.page, MB);
                uploaded = result.name;
                return { seconds: result.seconds, http: mode === "direct" ? http.length - n : 0 };
              });
            if (scenarios.has(`${mode}-down`))
              await measure(`${mode}-down`, browserName, profile, cpu, async () => {
                if (!uploaded) uploaded = (await upload(laptop.page, MB)).name;
                const n = before();
                const seconds = await download(laptop.page, uploaded);
                return { seconds, http: mode === "direct" ? http.length - n : 0 };
              });
          }
          await laptop.context.close();
        }
        if (b && scenarios.has("nearby")) {
          // Both devices on the same Wi-Fi: everything crosses the air twice, to the access point and
          // from it, so each gets half.
          shape(DEVICES[0], profile, 0.5);
          shape(DEVICES[1], profile, 0.5);
          shape(SERVER, "lan");
          const from = await device(a, `Bench sender ${browserName} ${cpu} ${profile}`);
          const to = await device(b, `Bench receiver ${browserName} ${cpu} ${profile}`);
          await measure("nearby", browserName, profile, cpu, async () => {
            for (const side of [from, to]) {
              await side.page.getByRole("link", { name: "Nearby" }).click();
              await side.page.getByRole("heading", { name: "Nearby", level: 1 }).waitFor();
            }
            const row = sendTo(from.page).getByRole("button", { name: to.name, exact: true });
            await expect(row).toHaveAccessibleDescription(/Ready/, { timeout: 30_000 });
            const name = `nearby-${Date.now()}-${serial++}.bin`;
            await pick(from.page, "nearby-file-input", name, MB);
            const started = performance.now();
            await row.click();
            const item = transfers(to.page)
              .getByRole("listitem", { name: `From ${from.name}` })
              .filter({ hasText: name });
            try {
              // Received, or ended any other way; even the weakest profile moves a megabyte a second.
              await item
                .getByText(/^Received$|ran out|isn’t room|didn’t match|Lost the connection|stopped/)
                .first()
                .waitFor({ timeout: 60_000 + MB * 1000 });
              if (!(await item.getByText("Received", { exact: true }).count()))
                throw new Error(`Not received: ${(await item.innerText()).replace(/\s+/g, " ")}`);
            } catch (error) {
              await snapshot("nearby", { sender: from.page, receiver: to.page });
              throw error;
            }
            const seconds = (performance.now() - started) / 1000;
            // Received files stay in the browser's storage until they're cleared, and a fresh
            // context's quota holds only two or so. The button shows once two transfers are over.
            for (const side of [from, to]) {
              const clear = transfers(side.page).getByRole("button", { name: "Clear finished" });
              if (await clear.isVisible()) await clear.click();
            }
            return { seconds, http: 0 };
          });
          await from.context.close();
          await to.context.close();
        }
      }
    }
    await a.close();
    await b?.close();
  }
} finally {
  if (!args.keep) stop();
}
