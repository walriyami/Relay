// Exercises the actual Compose topology on disposable resources and a random loopback port: one
// Relay container, published on loopback and reachable at http://relay:3090 by a tunnel connector
// on another network (compose.tunnel.yaml), with direct transfers. On Linux, also the host-network
// variant (compose.host.yaml). Build the relay-verify image before running this script. Never
// opens the user's configured data, origin or networks.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, type IncomingHttpHeaders } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import nodeDataChannel from "node-datachannel";
import { api } from "../shared/api.ts";
import { LocalPeer } from "./lib/local-peer.ts";
import { REPO, Session, assert, freePort, holdEvents, sleep, waitForHealth, setUpAdmin } from "./lib/relay.ts";

type ComposeResource = { name?: string; external?: boolean };
type ComposeService = {
  image?: string;
  build?: unknown;
  ports?: { published: string }[];
  environment: Record<string, string>;
  network_mode?: string;
};
type ComposeConfig = {
  name: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, ComposeResource>;
  volumes: Record<string, ComposeResource>;
};

const run = `relay-verify-compose-${Date.now().toString(36)}`;
const temp = await mkdtemp(join(tmpdir(), run));
const password = "Disposable-compose-verification-only";
const tunnel = `${run}-tunnel`;
const connector = `${run}-connector`;
const stranger = `${run}-stranger`;
const docker = (...args: string[]) =>
  execFileSync("docker", args, { cwd: REPO, encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL" }).trim();
const child = (cmd: string, args: string[], env = process.env) =>
  new Promise<void>((resolve, reject) => {
    const process = spawn(cmd, args, { cwd: REPO, env, stdio: "inherit", timeout: 15 * 60_000, killSignal: "SIGKILL" });
    process.once("error", reject);
    process.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });

/** The Compose configuration `files` render to, for a disposable project. */
function render(files: string, env: Record<string, string>): ComposeConfig {
  return JSON.parse(
    execFileSync("docker", ["compose", "--env-file", "/dev/null", "config", "--format", "json"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 180_000,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        COMPOSE_FILE: files,
        RELAY_SECRET: "",
        RELAY_DIRECT: "",
        RELAY_TRUST_PROXY: "",
        ...env,
      },
    }),
  ) as ComposeConfig;
}

/** Starts `config` as a disposable project and returns its compose command. */
async function up(project: string, config: ComposeConfig) {
  config.name = project;
  config.services.relay.image = "relay-verify";
  delete config.services.relay.build;
  for (const resource of [...Object.values(config.volumes), ...Object.values(config.networks ?? {})])
    if (!resource.external) delete resource.name;
  const file = join(temp, `${project}.json`);
  await writeFile(file, JSON.stringify(config));
  const compose = (...args: string[]) => docker("compose", "-p", project, "-f", file, ...args);
  projects.push(compose);
  compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "120");
  return compose;
}

/** Signs in as the administrator and connects the way a browser on the server's network does. */
async function checkDirect(origin: string) {
  const admin = new Session(origin);
  await admin.signIn("admin", password, "Compose verification");
  let local = (await admin.call(api.admin.overview)).local;
  for (const started = Date.now(); local.state !== "ready" && Date.now() - started < 30_000;) {
    await sleep(500);
    local = (await admin.call(api.admin.overview)).local;
  }
  assert(local.state === "ready", `Direct transfers are ${JSON.stringify(local)}`);
  assert((await admin.call(api.session.get)).local, "Signed-in browsers are not offered direct transfers");
  const peer = await LocalPeer.connect(admin);
  try {
    const check = await peer.fetch({ path: "/api/local/check" });
    assert(check.status === 200, `The direct check answered ${check.status}`);
    local = (await admin.call(api.admin.overview)).local;
    assert(local.state === "ready" && local.links === 1, `Direct transfers are ${JSON.stringify(local)}`);
  } finally {
    peer.close();
  }
  return admin;
}

const projects: ((...args: string[]) => string)[] = [];
const containers: string[] = [];
let network = false;
try {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
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

  const plain = render("compose.yaml", { RELAY_ORIGIN: origin });
  assert(Object.keys(plain.services).join() === "relay", "Compose must run Relay alone");
  assert(
    Object.values(plain.networks ?? {}).every((n) => !n.external),
    "Default Compose requires an external network",
  );

  // The tunnel's network and its connector exist first, as they do for a real deployment. A second
  // container on that network, not named in RELAY_TRUST_PROXY, stands in for anything else there.
  docker("network", "create", tunnel);
  network = true;
  for (const name of [connector, stranger]) {
    docker(
      "run",
      "-d",
      "--name",
      name,
      "--network",
      tunnel,
      "--read-only",
      "--cap-drop",
      "ALL",
      "relay-verify",
      "node",
      "-e",
      "setInterval(() => {}, 1 << 30)",
    );
    containers.push(name);
  }
  const config = render("compose.yaml:compose.tunnel.yaml", {
    RELAY_ORIGIN: origin,
    RELAY_TUNNEL_NETWORK: tunnel,
    RELAY_TRUST_PROXY: connector,
  });
  assert(config.services.relay.ports?.length === 1, "Relay must be published once");
  config.services.relay.ports[0].published = String(port);
  const compose = await up(run, config);
  await waitForHealth(origin, 60_000);
  await setUpAdmin(origin, password, () => compose("exec", "-T", "relay", "cat", "/data/setup.key"));

  // Through the tunnel: the connector reaches Relay at http://relay:3090, and each visitor it reports
  // keeps their own limits (checking an invitation allows 20 a minute per address). Anything else on
  // that network speaks only for itself.
  const viaTunnel = (from: string, visitors: string[]) =>
    JSON.parse(
      docker(
        "exec",
        from,
        "node",
        "-e",
        `const { request } = require("node:http");
         const ask = (visitor) => new Promise((resolve) =>
           request({ host: "relay", port: 3090, path: "/api/invitations/verify-compose",
             headers: { host: ${JSON.stringify(new URL(origin).host)}, "x-forwarded-for": visitor } },
             (res) => { res.resume(); resolve(res.statusCode); }).on("error", () => resolve(0)).end());
         (async () => { const out = []; for (const v of ${JSON.stringify(visitors)}) out.push(await ask(v)); console.log(JSON.stringify(out)); })();`,
      ),
    ) as number[];
  const reported = viaTunnel(connector, [...Array<string>(21).fill("198.51.100.1"), "198.51.100.2"]);
  assert(
    reported.slice(0, 20).every((s) => s === 410) && reported[20] === 429,
    `Through the tunnel, a visitor's limit answered ${reported.join()}`,
  );
  assert(reported[21] === 410, "Visitors through the tunnel share one limit");
  const claimed = viaTunnel(stranger, [...Array<string>(20).fill("198.51.100.3"), "198.51.100.4"]);
  assert(claimed[20] === 429, "An untrusted container chose its own address");

  // Direct transfers, from this host, with no address configured anywhere.
  const admin = await checkDirect(origin);

  // Relay serves its own compressed copies of the app's files.
  const html = await wire("/", "identity");
  assert(html.headers["cache-control"] === "no-cache", "HTML must revalidate");
  const asset = html.body.toString().match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert(asset, "Missing production JS asset");
  const original = await wire(asset, "identity");
  assert(!original.headers["content-encoding"], "Identity was compressed");
  const sizes: Record<string, number> = { original: original.body.length };
  for (const [encoding, decode] of [
    ["br", brotliDecompressSync],
    ["gzip", gunzipSync],
  ] as const) {
    const copy = await wire(asset, `${encoding}, identity`);
    assert(copy.headers["content-encoding"] === encoding, `App JS was not served as ${encoding}`);
    assert(/(?:^|,)\s*accept-encoding\s*(?:,|$)/i.test(String(copy.headers.vary)), "Compressed JS must vary");
    assert(copy.headers["cache-control"] === "public, max-age=31536000, immutable", "Bundle must cache immutably");
    assert(copy.headers["content-type"]?.startsWith("application/javascript"), "Compressed JS lost its type");
    assert(decode(copy.body).equals(original.body), `The ${encoding} copy differs`);
    assert(copy.body.length < original.body.length * 0.4, `Unexpectedly ineffective ${encoding} compression`);
    sizes[encoding] = copy.body.length;
  }
  assert((await wire(`${asset}.br`, "identity")).status === 404, "Compressed copies must not be served by name");
  assert((await wire("/theme.js", "gzip")).headers["cache-control"] === "no-cache", "Unversioned JS must revalidate");
  assert((await wire("/assets/missing.js", "gzip")).status === 404, "Missing bundle must not serve HTML");
  assert((await wire("/settings", "gzip")).headers["cache-control"] === "no-cache", "SPA fallback must revalidate");
  const health = await wire("/api/health", "gzip");
  assert(
    !health.headers["content-encoding"] && health.headers["cache-control"] === "no-store",
    "API representation changed",
  );

  // An update replaces the container. With a member's event stream open, Relay must stop and be
  // back quickly: while it's away, there is nothing in front of it to hold requests.
  const streams = new AbortController();
  await holdEvents(admin, streams.signal);
  let longest = 0;
  let last = Date.now();
  let polling = true;
  const poll = (async () => {
    while (polling) {
      const ok = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }).then(
        (r) => r.ok,
        () => false,
      );
      const now = Date.now();
      if (ok) {
        longest = Math.max(longest, now - last);
        last = now;
      }
      await sleep(50);
    }
  })();
  compose("up", "-d", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "120");
  await waitForHealth(origin, 30_000);
  await sleep(200);
  polling = false;
  await poll;
  streams.abort();
  assert(longest < 10_000, `Relay was unreachable for ${longest} ms while it was replaced`);

  await child(process.execPath, ["scripts/verify-deployment.ts", "--run-live", "--origin", origin], {
    ...process.env,
    RELAY_VERIFY_USERNAME: "admin",
    RELAY_VERIFY_PASSWORD: password,
  });

  // Docker Engine on Linux can share the host's network, for direct transfers at its own addresses.
  let host = "skipped: needs Docker Engine on Linux";
  if (process.platform === "linux") {
    const hostPort = await freePort();
    const hostOrigin = `http://127.0.0.1:${hostPort}`;
    const config = render("compose.yaml:compose.host.yaml", {
      RELAY_ORIGIN: hostOrigin,
      RELAY_DIRECT_PORT: String(20000 + Math.floor(Math.random() * 12000)),
    });
    assert(config.services.relay.network_mode === "host" && !config.services.relay.ports?.length, "Not host mode");
    config.services.relay.environment.PORT = String(hostPort);
    const hosted = await up(`${run}-host`, config);
    await waitForHealth(hostOrigin, 60_000);
    await setUpAdmin(hostOrigin, password, () => hosted("exec", "-T", "relay", "cat", "/data/setup.key"));
    await checkDirect(hostOrigin);
    host = "passed";
  }

  console.log(
    JSON.stringify({
      passed: true,
      scope: "one-container Compose with tunnel network, direct transfers and precompressed assets",
      javascriptBytes: sizes,
      replacedWithinMs: longest,
      hostNetwork: host,
    }),
  );
} catch (error) {
  for (const compose of projects)
    try {
      console.error(compose("logs", "--tail", "20"));
    } catch (logsError) {
      console.error("Could not collect Compose logs:", logsError);
    }
  throw error;
} finally {
  try {
    for (const compose of projects) compose("down", "--volumes", "--remove-orphans", "--timeout", "30");
    for (const name of containers) docker("rm", "-f", name);
    if (network) docker("network", "rm", tunnel);
  } catch (cleanupError) {
    console.error("Compose cleanup failed:", cleanupError);
    process.exitCode = 1;
  } finally {
    await rm(temp, { recursive: true, force: true });
    // The peer's library threads keep the process alive until it's told to stop.
    nodeDataChannel.cleanup();
  }
}
