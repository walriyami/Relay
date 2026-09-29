// The direct-transfer helper: terminates browsers' WebRTC connections and forwards what they carry to
// Relay (see shared/local.ts). Relay asks it to accept a connection over the helper socket. It checks
// the browser's candidates from its one UDP port, and announces the host's addresses on that port;
// either way gets the connection up. Checking the browser's matters where the host's addresses
// can't be known or reached from outside, as for a container on Docker Desktop: its checks leave
// through the host like any outgoing traffic, and the browser answers them.
import { chmod, mkdir, rm } from "node:fs/promises";
import { Agent, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import nodeDataChannel, { type PeerConnection } from "node-datachannel";
import { LOCAL, SOCKETS, type HelperStatus } from "../shared/local.ts";
import { isLocalAddress } from "./addresses.ts";
import { hold } from "./channels.ts";
import { exchange } from "./exchange.ts";

export type HelperOptions = {
  /** The private directory shared with Relay. */
  dir: string;
  /** The UDP port every connection uses. */
  port: number;
  /** Addresses to announce; asked afresh for every connection, since the host's may change. */
  addresses: () => string[];
  log: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
};

/** Connections at once, overall and per session (a session is one browser; each tab connects). */
const MAX_LINKS = 64;
const MAX_LINKS_PER_SESSION = 8;
/** Requests one connection may carry at once. */
const MAX_EXCHANGES = 16;
/** A connection must be up this soon after its answer, and may be lost this long before it's closed. */
const CONNECT_TIMEOUT_MS = 20_000;
const DISCONNECTED_GRACE_MS = 10_000;

type Link = {
  pc: PeerConnection;
  token: string;
  /** Cancels each request in flight. */
  exchanges: Set<() => void>;
  timer?: NodeJS.Timeout;
};

export async function startHelper(options: HelperOptions) {
  const links = new Set<Link>();
  const agent = new Agent({ keepAlive: true, maxSockets: MAX_LINKS * 4 });
  const relaySocket = join(options.dir, SOCKETS.relay);
  let sequence = 0;

  const close = (link: Link) => {
    if (!links.delete(link)) return;
    clearTimeout(link.timer);
    for (const cancel of [...link.exchanges]) cancel();
    link.pc.close();
  };

  async function connect(offer: string, token: string) {
    const addresses = options.addresses();
    // One browser's tabs replace its oldest connection; many browsers must wait.
    const own = [...links].filter((l) => l.token === token);
    if (own.length >= MAX_LINKS_PER_SESSION) close(own[0]);
    if (links.size >= MAX_LINKS) throw new HelperError(503, "Too many connections.");

    const pc = new nodeDataChannel.PeerConnection(`link-${++sequence}`, {
      iceServers: [],
      enableIceUdpMux: true,
      portRangeBegin: options.port,
      portRangeEnd: options.port,
      maxMessageSize: 256 * 1024,
    });
    const link: Link = { pc, token, exchanges: new Set() };
    links.add(link);
    link.timer = setTimeout(() => close(link), CONNECT_TIMEOUT_MS);
    pc.onStateChange((state) => {
      // Closing reports states of its own; the link is already gone.
      if (!links.has(link)) return;
      if (state === "connected") {
        clearTimeout(link.timer);
        link.timer = undefined;
      } else if (state === "disconnected") {
        clearTimeout(link.timer);
        link.timer = setTimeout(() => close(link), DISCONNECTED_GRACE_MS);
      } else if (state === "failed" || state === "closed") close(link);
    });
    pc.onDataChannel((channel) => {
      if (!links.has(link) || link.exchanges.size >= MAX_EXCHANGES) {
        hold(channel);
        return channel.close();
      }
      const cancel = exchange(channel, { socketPath: relaySocket, agent, token }, () => link.exchanges.delete(cancel));
      link.exchanges.add(cancel);
    });
    try {
      pc.setRemoteDescription(localOffer(offer), "offer");
      await gathered(pc);
      const answer = pc.localDescription()?.sdp;
      if (!answer) throw new Error("No answer was created.");
      return announce(answer, addresses, options.port);
    } catch (error) {
      close(link);
      throw error;
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (error instanceof HelperError) return reply(res, error.status, { error: error.message });
      // The offer passed its checks, so the failure is the helper's: its port taken, say.
      options.log("warn", "A connection could not be set up.", { err: String(error) });
      reply(res, 503, { error: "The connection could not be set up." });
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET" && req.url === "/status") {
      const status: HelperStatus = { links: connected() };
      return reply(res, 200, status);
    }
    if (req.method === "POST" && req.url === "/connect") {
      const { offer, token } = await readJson(req);
      if (typeof offer !== "string" || offer.length > LOCAL.offerBytes || !isDataOffer(offer))
        throw new HelperError(400, "The offer is not a data connection offer.");
      if (typeof token !== "string" || !token || token.length > 256) throw new HelperError(400, "No session token.");
      return reply(res, 200, { answer: await connect(offer, token) });
    }
    reply(res, 404, { error: "Not found." });
  }
  const connected = () => [...links].filter((l) => l.pc.state() === "connected").length;

  await mkdir(options.dir, { recursive: true });
  const path = join(options.dir, SOCKETS.helper);
  await rm(path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(path, 0o600);

  return {
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      for (const link of [...links]) close(link);
      agent.destroy();
      await rm(path, { force: true });
    },
  };
}

class HelperError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 2 * LOCAL.offerBytes) throw new HelperError(400, "The request is too large.");
  }
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object") return value as Record<string, unknown>;
  } catch {
    // Refused below.
  }
  throw new HelperError(400, "The request is not JSON.");
}

/** One data (SCTP) section and nothing else: no audio, video or other media to negotiate. */
function isDataOffer(sdp: string) {
  if (!sdp.startsWith("v=0")) return false;
  const media = sdp.split(/\r?\n/).filter((line) => line.startsWith("m="));
  return media.length === 1 && /^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel/.test(media[0]);
}

/** Resolves once the connection knows its own candidates; without STUN servers that is at once. */
function gathered(pc: PeerConnection) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Gathering candidates took too long.")), 3000);
    const check = () => {
      if (pc.gatheringState() !== "complete") return false;
      clearTimeout(timer);
      resolve();
      return true;
    };
    if (!check()) pc.onGatheringStateChange(() => void check());
  });
}

/**
 * The offer with only the candidates the helper may check: over UDP, at local network addresses
 * (see isLocalAddress). Checking any other would reach beyond the local network.
 */
export function localOffer(sdp: string) {
  return sdp
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.startsWith("a=candidate:")) return true;
      // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> …
      const [, , transport, , address] = line.slice("a=candidate:".length).split(" ");
      return transport?.toUpperCase() === "UDP" && isLocalAddress(address ?? "");
    })
    .join("\r\n");
}

/**
 * Replaces the answer's candidates with the addresses the helper announces, all on its one port:
 * the host's own network addresses rather than those the helper's interfaces happen to have, and
 * no container bridges. The browser's checks reach the shared UDP socket whichever it tries. With
 * none to announce, the helper's own checks set the connection up.
 */
export function announce(sdp: string, addresses: string[], port: number) {
  // The connection line and media port name the default candidate: the first announced, or none.
  const first = addresses[0] ?? "0.0.0.0";
  const family = first.includes(":") ? "IP6" : "IP4";
  const lines = sdp
    .split(/\r?\n/)
    .filter((line) => line && !/^a=(candidate:|end-of-candidates)/.test(line))
    .map((line) =>
      line.startsWith("m=application ")
        ? line.replace(/^m=application \d+/, `m=application ${addresses.length ? port : 9}`)
        : line.startsWith("c=IN ")
          ? `c=IN ${family} ${first}`
          : line,
    );
  const candidates = addresses.map(
    // Host candidates, earlier addresses preferred: type preference 126, then descending local preference.
    (address, i) =>
      `a=candidate:${i + 1} 1 UDP ${126 * 2 ** 24 + (65535 - i) * 2 ** 8 + 255} ${address} ${port} typ host`,
  );
  return [...lines, ...candidates, "a=end-of-candidates", ""].join("\r\n");
}
