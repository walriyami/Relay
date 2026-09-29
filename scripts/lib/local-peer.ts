// A browser's side of a direct connection (see shared/local.ts), in Node: node-datachannel stands in
// for RTCPeerConnection, so tests and verification drive the helper and Relay's socket exactly as a
// page does.
import nodeDataChannel, { type DataChannel, type PeerConnection } from "node-datachannel";
import { api } from "../../shared/api.ts";
import { hold } from "../../local/channels.ts";
import { LOCAL, type LocalControl, type LocalResponse } from "../../shared/local.ts";
import type { Session } from "./relay.ts";

export type LocalReply = { status: number; headers: Record<string, string>; body: Buffer };
export type LocalFetch = {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
  /** Waits this long before returning each credit, to hold the helper at its window. */
  creditDelayMs?: number;
  /** Called before each credit is returned, with the body bytes received so far and the most the helper was allowed to send. */
  onCredit?: (received: number, allowed: number) => void;
};

export class LocalPeer {
  readonly pc: PeerConnection;
  private constructor(pc: PeerConnection) {
    this.pc = pc;
  }

  /** Sets up a connection the way the page does, signed in as `client`. */
  static async connect(client: Pick<Session, "call">): Promise<LocalPeer> {
    const pc = new nodeDataChannel.PeerConnection("browser", { iceServers: [] });
    const first = pc.createDataChannel("relay");
    hold(first);
    try {
      pc.setLocalDescription();
      // With its candidates, as a page's offer has them.
      const offer = await until(() => (pc.gatheringState() === "complete" ? pc.localDescription()?.sdp : undefined));
      const { answer } = await client.call(api.local.connect, { body: { offer } });
      pc.setRemoteDescription(answer, "answer");
      await opened(first);
      first.close();
      return new LocalPeer(pc);
    } catch (error) {
      first.close();
      pc.close();
      throw error;
    }
  }

  /** One request on a channel of its own, answered in full. */
  async fetch(request: LocalFetch): Promise<LocalReply> {
    let closed = () => {};
    const channel = await this.channel(() => closed());
    return exchange(channel, request, (onClosed) => (closed = onClosed));
  }

  /** A channel that is open and has sent nothing, for tests that break the protocol. */
  async channel(onClosed?: () => void): Promise<DataChannel> {
    const channel = this.pc.createDataChannel("request");
    hold(channel, onClosed);
    await opened(channel);
    return channel;
  }

  close() {
    this.pc.close();
  }
}

/** `whenClosed` registers what the channel's close does; the channel's own handler belongs to hold(). */
function exchange(
  channel: DataChannel,
  request: LocalFetch,
  whenClosed: (onClosed: () => void) => void,
): Promise<LocalReply> {
  const body = request.body ?? Buffer.alloc(0);
  return new Promise<LocalReply>((resolve, reject) => {
    let head: LocalResponse | null = null;
    const chunks: Buffer[] = [];
    let received = 0;
    let credited = 0;
    let allowed: number = LOCAL.windowBytes;
    let allowance: number = LOCAL.windowBytes;
    let sent = 0;
    const sendBody = () => {
      while (!head && sent < body.length && allowance > 0) {
        const piece = body.subarray(sent, sent + Math.min(LOCAL.messageBytes, allowance));
        channel.sendMessageBinary(piece);
        sent += piece.length;
        allowance -= piece.length;
      }
    };
    channel.onMessage((message) => {
      if (typeof message !== "string") {
        const bytes = Buffer.isBuffer(message) ? message : Buffer.from(message);
        chunks.push(bytes);
        received += bytes.length;
        if (received - credited >= LOCAL.creditBytes) {
          const credit = received - credited;
          credited = received;
          const give = () => {
            request.onCredit?.(received, allowed);
            allowed += credit;
            if (channel.isOpen()) channel.sendMessage(JSON.stringify({ credit }));
          };
          if (request.creditDelayMs) setTimeout(give, request.creditDelayMs);
          else give();
        }
        return;
      }
      const data = JSON.parse(message) as LocalResponse | LocalControl;
      if ("status" in data) head = data;
      else if ("credit" in data) {
        allowance += data.credit;
        sendBody();
      } else if ("end" in data) {
        channel.close();
        resolve({ status: head!.status, headers: head!.headers, body: Buffer.concat(chunks) });
      } else {
        channel.close();
        reject(new Error(data.error));
      }
    });
    whenClosed(() => reject(new Error("The channel closed.")));
    channel.sendMessage(
      JSON.stringify({
        method: request.method ?? "GET",
        path: request.path,
        headers: request.headers ?? {},
        length: body.length,
      }),
    );
    sendBody();
  });
}

function opened(channel: DataChannel) {
  return new Promise<void>((resolve, reject) => {
    if (channel.isOpen()) return resolve();
    const timer = setTimeout(() => reject(new Error("The channel did not open.")), 5000);
    channel.onOpen(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function until<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  for (const started = Date.now(); Date.now() - started < timeoutMs;) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out.");
}
