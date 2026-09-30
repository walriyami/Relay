// The direct-transfer helper: terminates browsers' WebRTC connections and forwards what they carry to
// Relay (see shared/local.ts). Relay asks it to accept a connection over the helper socket. It checks
// the browser's candidates from its one UDP port, and announces the host's addresses on that port;
// either way gets the connection up. Checking the browser's matters where the host's addresses
// can't be known or reached from outside, as for a container on Docker Desktop: its checks leave
// through the host like any outgoing traffic, and the browser answers them.
//
// That sets up a connection's first lane (see shared/lanes.ts); the browser offers the others on it,
// and they're answered the same way.
import { chmod, mkdir, rm } from "node:fs/promises";
import { Agent, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import nodeDataChannel, { type PeerConnection } from "node-datachannel";
import { LANES, Mux, type Lane } from "../shared/lanes.ts";
import { LOCAL, SOCKETS, type HelperStatus } from "../shared/local.ts";
import { isLocalAddress } from "./addresses.ts";
import { Exchanges } from "./exchange.ts";
import { feed, gathered, laneChannel, laneOf } from "./lanes.ts";

export type HelperOptions = {
  /** The private directory shared with Relay. */
  dir: string;
  /** The UDP port every connection uses. */
  port: number;
  /** Addresses to announce; asked afresh for every connection, since the host's may change. */
  addresses: () => string[];
  log: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
};

/**
 * Connections at once, overall and per session (a session is one browser; each tab connects). Each
 * is up to LANES.count peer connections.
 */
const MAX_LINKS = 32;
const MAX_LINKS_PER_SESSION = 8;
/** A lane must be up this soon after its answer; the first may be lost this long before the connection is closed. */
const CONNECT_TIMEOUT_MS = 20_000;
const DISCONNECTED_GRACE_MS = 10_000;
/**
 * Bytes each lane lets arrive per round trip; libdatachannel's default holds uploads well below
 * what the local network carries. Sending, the browser's side is what limits a lane.
 */
const SCTP_RECEIVE_BYTES = 8 * 1024 ** 2;

type Link = {
  token: string;
  mux: Mux;
  exchanges: Exchanges;
  /** The first lane: the connection lasts as long as it does. */
  first: PeerConnection;
  opened: boolean;
  /** The other lanes that opened, until they close; and those answered that haven't opened yet. */
  others: Set<PeerConnection>;
  pending: Set<PeerConnection>;
  /** The browser offered its other lanes; it does once. */
  settled: boolean;
  /** Closes the connection if the first lane doesn't open in time, or stays lost. */
  timer?: NodeJS.Timeout;
};

export async function startHelper(options: HelperOptions) {
  const links = new Set<Link>();
  const agent = new Agent({ keepAlive: true, maxSockets: MAX_LINKS * 4 });
  const relaySocket = join(options.dir, SOCKETS.relay);
  let sequence = 0;
  nodeDataChannel.setSctpSettings({ recvBufferSize: SCTP_RECEIVE_BYTES });

  const close = (link: Link) => {
    if (!links.delete(link)) return;
    clearTimeout(link.timer);
    link.exchanges.close();
    link.mux.close();
    for (const pc of [link.first, ...link.others, ...link.pending]) pc.close();
  };

  /** A peer connection answering `offer`, on the helper's one port, its lane's channel created. */
  const answering = (offer: string, onClosed: () => void) => {
    const pc = new nodeDataChannel.PeerConnection(`lane-${++sequence}`, {
      iceServers: [],
      enableIceUdpMux: true,
      portRangeBegin: options.port,
      portRangeEnd: options.port,
      maxMessageSize: LANES.frameBytes,
    });
    try {
      pc.setRemoteDescription(localOffer(offer), "offer");
      return { pc, channel: laneChannel(pc, onClosed) };
    } catch (error) {
      pc.close();
      throw error;
    }
  };
  const answer = async (pc: PeerConnection, addresses: string[]) => {
    await gathered(pc);
    const sdp = pc.localDescription()?.sdp;
    if (!sdp) throw new Error("No answer was created.");
    return announce(sdp, addresses, options.port);
  };

  async function connect(offer: string, token: string) {
    const addresses = options.addresses();
    // One browser's tabs replace its oldest connection; many browsers must wait.
    const own = [...links].filter((l) => l.token === token);
    if (own.length >= MAX_LINKS_PER_SESSION) close(own[0]);
    if (links.size >= MAX_LINKS) throw new HelperError(503, "Too many connections.");

    // Nothing arrives, and nothing closes, before the connection is set up below.
    const { pc, channel } = answering(offer, () => close(link));
    const mux = new Mux(
      laneOf(channel),
      {
        control: (message) => {
          if ("lanes" in message) void lanes(link, message.lanes);
          else if (!link.exchanges.control(message)) close(link);
        },
        broken: () => close(link),
      },
      LOCAL.messageChars,
    );
    const link: Link = {
      token,
      mux,
      exchanges: new Exchanges(mux, { socketPath: relaySocket, agent, token }),
      first: pc,
      opened: false,
      others: new Set(),
      pending: new Set(),
      settled: false,
      timer: setTimeout(() => close(link), CONNECT_TIMEOUT_MS),
    };
    links.add(link);
    feed(mux, channel);
    channel.onOpen(() => {
      if (!links.has(link)) return;
      link.opened = true;
      clearTimeout(link.timer);
      link.timer = undefined;
    });
    pc.onStateChange((state) => {
      // Closing reports states of its own; the connection is already gone.
      if (!links.has(link)) return;
      if (state === "failed" || state === "closed") return close(link);
      if (!link.opened) return;
      clearTimeout(link.timer);
      link.timer = state === "disconnected" ? setTimeout(() => close(link), DISCONNECTED_GRACE_MS) : undefined;
    });
    try {
      return await answer(pc, addresses);
    } catch (error) {
      close(link);
      throw error;
    }
  }

  /** Answers the browser's offers for the connection's other lanes. */
  async function lanes(link: Link, offers: unknown) {
    if (link.settled) return close(link);
    link.settled = true;
    const valid =
      Array.isArray(offers) &&
      offers.length < LANES.count &&
      offers.every((sdp) => typeof sdp === "string" && sdp.length <= LOCAL.offerBytes && isDataOffer(sdp));
    if (!valid) return close(link);
    const addresses = options.addresses();
    const answers: string[] = [];
    // Answers pair with offers in order, so the first lane that can't be made ends the list.
    for (const offer of offers as string[]) {
      if (!links.has(link)) return;
      let lane: ReturnType<typeof answering>;
      try {
        lane = answering(offer, () => gone());
      } catch {
        break;
      }
      const { pc, channel } = lane;
      let own: Lane | undefined;
      /** Closed, or never opened: it's let go, and what it carried goes on the others. */
      const gone = () => {
        if (!(link.others.delete(pc) || link.pending.delete(pc))) return;
        clearTimeout(timer);
        if (own) link.mux.remove(own);
        pc.close();
      };
      const timer = setTimeout(gone, CONNECT_TIMEOUT_MS);
      link.pending.add(pc);
      channel.onOpen(() => {
        if (!links.has(link) || !link.pending.delete(pc)) return;
        clearTimeout(timer);
        link.others.add(pc);
        own = laneOf(channel);
        feed(link.mux, channel);
        link.mux.add(own);
      });
      // A lane that loses its path carries nothing until it finds it again.
      pc.onStateChange((state) => {
        if (state === "failed" || state === "closed") gone();
        else if (own && link.others.has(pc)) {
          if (state === "disconnected") link.mux.remove(own);
          else if (state === "connected") link.mux.add(own);
        }
      });
      try {
        answers.push(await answer(pc, addresses));
      } catch {
        gone();
        break;
      }
    }
    if (links.has(link)) link.mux.send({ lanes: answers });
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
  const connected = () => [...links].filter((l) => l.opened).length;

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
