// Which addresses a WebRTC connection may try. Direct (local/helper.ts) and Nearby (browser to
// browser) both promise to stay on the local network, and use no STUN or TURN server, so the only
// addresses either side tries are the candidates the other side's description names. A description
// that comes from someone else (a Nearby guest, another member) could name any address on the
// internet, and the browser would send its connectivity checks there, from the home or office
// network's public address. So every description from the other side is cut down to its local
// candidates before it's used.

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** An IPv6 address in its shortest form, or null for anything else. */
function ipv6(address: string) {
  if (!/^[0-9a-f:.]+$/i.test(address) || !address.includes(":")) return null;
  try {
    const host = new URL(`http://[${address}]/`).hostname;
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : null;
  } catch {
    return null;
  }
}

/**
 * Whether a candidate at `address` stays on the local network: a .local name (as browsers hide
 * their addresses, found only on the local network), or a private, link-local or loopback address.
 * Anything else would reach beyond it.
 */
export function isLocalAddress(address: string) {
  if (/^[0-9a-z][0-9a-z-]*\.local$/i.test(address)) return true;
  if (V4.test(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127
    );
  }
  const v6 = ipv6(address);
  // Unique local (fc00::/7), link-local (fe80::/10) and loopback.
  return v6 !== null && (/^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6) || v6 === "::1");
}

/**
 * `sdp` with only its candidates on the local network (see isLocalAddress), and with `udpOnly`, only
 * those over UDP. Any line break separates lines here, as it may in a browser's own reading, so no
 * candidate can hide inside another line.
 */
export function localCandidates(sdp: string, { udpOnly = false } = {}) {
  return sdp
    .split(/\r\n|\r|\n/)
    .filter((line) => {
      const candidate = /^\s*a=candidate:/i.exec(line);
      if (!candidate) return true;
      // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> …
      const [, , transport, , address] = line.slice(candidate[0].length).split(" ");
      return (!udpOnly || transport?.toUpperCase() === "UDP") && isLocalAddress(address ?? "");
    })
    .join("\r\n");
}
