// Exercises the actual portable Compose topology on disposable resources and a random loopback port.
// Build the relay-verify image before running this script. Never opens the user's configured data or origin.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, type IncomingHttpHeaders } from "node:http";
import { gunzipSync } from "node:zlib";
import { api } from "../shared/api.ts";
import { REPO, Session, assert, freePort, sleep, waitForHealth, setUpAdmin } from "./lib/relay.ts";

type ComposeResource = { name?: string; external?: boolean };
type ComposeConfig = {
  name: string;
  services: Record<string, { image?: string; build?: unknown; ports: { published: string }[] }>;
  networks: Record<string, ComposeResource>;
  volumes: Record<string, ComposeResource>;
};

const run = `relay-verify-compose-${Date.now().toString(36)}`;
const temp = await mkdtemp(join(tmpdir(), run));
const file = join(temp, "compose.json");
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const password = "Disposable-compose-verification-only";
const docker = (...args: string[]) =>
  execFileSync("docker", args, { cwd: REPO, encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL" }).trim();
const compose = (...args: string[]) => docker("compose", "-p", run, "-f", file, ...args);
const child = (cmd: string, args: string[], env = process.env) =>
  new Promise<void>((resolve, reject) => {
    const process = spawn(cmd, args, { cwd: REPO, env, stdio: "inherit", timeout: 15 * 60_000, killSignal: "SIGKILL" });
    process.once("error", reject);
    process.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
const wire = (path: string, encoding: string) =>
  new Promise<{ headers: IncomingHttpHeaders; body: Buffer; status: number }>((resolve, reject) => {
    get(
      origin + path,
      { headers: { "Accept-Encoding": encoding }, signal: AbortSignal.timeout(30_000) },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ headers: response.headers, body: Buffer.concat(chunks), status: response.statusCode! }),
        );
        response.on("error", reject);
      },
    ).on("error", reject);
  });
let created = false;
try {
  // Pick a /29 outside existing Docker subnets, without changing the topology under test.
  const ids = docker("network", "ls", "-q").split(/\s+/).filter(Boolean);
  const networks = ids.length
    ? (JSON.parse(docker("network", "inspect", ...ids)) as { IPAM: { Config: { Subnet?: string }[] } }[])
    : [];
  const ipv4 = (s: string) => s.split(".").reduce((n, p) => (n * 256 + Number(p)) >>> 0, 0);
  const used = networks
    .flatMap((n) => n.IPAM.Config ?? [])
    .map((c) => c.Subnet)
    .filter((s): s is string => !!s && !s.includes(":"));
  const third = Array.from({ length: 250 }, (_, i) => i + 1).find((i) =>
    used.every((s) => {
      const [address, bits] = s.split("/");
      const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
      return (ipv4(`172.29.${i}.0`) & mask) !== (ipv4(address) & mask);
    }),
  );
  assert(third !== undefined, "No free verifier subnet in 172.29.0.0/16");
  const prefix = `172.29.${third}`;
  const config = JSON.parse(
    execFileSync("docker", ["compose", "--env-file", "/dev/null", "-f", "compose.yaml", "config", "--format", "json"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 180_000,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        RELAY_ORIGIN: origin,
        RELAY_SECRET: "",
        RELAY_TRUST_PROXY: "127.0.0.1,::1",
        RELAY_CADDY_TRUSTED_PROXIES: "127.0.0.1 ::1",
        RELAY_BACKEND_SUBNET: `${prefix}.0/29`,
        RELAY_GATEWAY_IP: `${prefix}.2`,
        RELAY_APP_IP: `${prefix}.3`,
        RELAY_LOCAL_PORT: String(await freePort()),
      },
    }),
  ) as ComposeConfig;
  assert(
    Object.values(config.networks).every((n) => !n.external),
    "Default Compose requires an external network",
  );
  config.name = run;
  for (const service of ["relay", "relay-local"]) {
    config.services[service].image = "relay-verify";
    delete config.services[service].build;
  }
  config.services["relay-gateway"].ports[0].published = String(port);
  for (const resource of [...Object.values(config.volumes), ...Object.values(config.networks)]) delete resource.name;
  await writeFile(file, JSON.stringify(config));
  created = true;
  compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "120");
  await waitForHealth(origin, 60_000);
  await setUpAdmin(origin, password, () => compose("exec", "-T", "relay", "cat", "/data/setup.key"));
  // Relay and relay-local find each other through their shared socket directory.
  const admin = new Session(origin);
  await admin.signIn("admin", password, "Compose verification");
  let local = (await admin.call(api.admin.overview)).local;
  for (const started = Date.now(); local.state !== "ready" && Date.now() - started < 30_000;) {
    await sleep(500);
    local = (await admin.call(api.admin.overview)).local;
  }
  assert(local.state === "ready", `relay-local is ${local.state}`);
  assert((await admin.call(api.session.get)).local, "Signed-in browsers are not offered direct transfers");
  await admin.call(api.session.signOut);
  const html = await wire("/", "identity");
  assert(html.headers["cache-control"] === "no-cache", "HTML must revalidate");
  const asset = html.body.toString().match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert(asset, "Missing production JS asset");
  const plain = await wire(asset, "identity");
  const compressed = await wire(asset, "gzip");
  assert(compressed.headers["content-encoding"] === "gzip", "Gateway did not compress app JS");
  assert(
    /(?:^|,)\s*accept-encoding\s*(?:,|$)/i.test(String(compressed.headers.vary)),
    "Compressed app assets must vary by Accept-Encoding",
  );
  assert(compressed.headers["cache-control"] === "public, max-age=31536000, immutable", "Bundle must cache immutably");
  assert(gunzipSync(compressed.body).equals(plain.body), "Compressed representation differs");
  assert(compressed.body.length < plain.body.length * 0.5, "Unexpectedly ineffective JS compression");
  assert((await wire("/theme.js", "gzip")).headers["cache-control"] === "no-cache", "Unversioned JS must revalidate");
  assert((await wire("/assets/missing.js", "gzip")).status === 404, "Missing bundle must not serve HTML");
  assert((await wire("/settings", "gzip")).headers["cache-control"] === "no-cache", "SPA fallback must revalidate");
  const health = await wire("/api/health", "gzip");
  assert(
    !health.headers["content-encoding"] && health.headers["cache-control"] === "no-store",
    "API representation changed",
  );
  await child(process.execPath, ["scripts/verify-deployment.ts", "--run-live", "--origin", origin], {
    ...process.env,
    RELAY_VERIFY_USERNAME: "admin",
    RELAY_VERIFY_PASSWORD: password,
  });
  console.log(
    JSON.stringify({
      passed: true,
      scope: "portable Compose with bundled gateway and relay-local, disposable loopback HTTP",
      javascript: { originalBytes: plain.body.length, gzipBytes: compressed.body.length },
    }),
  );
} catch (error) {
  if (created) {
    try {
      console.error(compose("logs", "--tail", "20"));
    } catch (logsError) {
      console.error("Could not collect Compose logs:", logsError);
    }
  }
  throw error;
} finally {
  try {
    if (created) compose("down", "--volumes", "--remove-orphans", "--timeout", "30");
  } catch (cleanupError) {
    console.error("Compose cleanup failed:", cleanupError);
    process.exitCode = 1;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
