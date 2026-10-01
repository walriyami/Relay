// Pages open Relay at http://localhost:3091, as on the machine it runs on, so it is a secure context
// for WebRTC; this passes that port on to the server container.
import { connect, createServer } from "node:net";
const [host, port] = (process.env.TARGET ?? "server:3091").split(":");
createServer((client) => {
  const upstream = connect(Number(port), host);
  client.pipe(upstream).pipe(client);
  const close = () => (client.destroy(), upstream.destroy());
  client.on("error", close);
  upstream.on("error", close);
}).listen(3091, "127.0.0.1");
