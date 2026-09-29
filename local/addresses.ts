import { isIPv4, isIPv6 } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

// Bridges that containers and virtual machines hang off. Nothing else on the network can reach
// their addresses, so they are never announced.
const VIRTUAL = /^(br-|cali|cilium|cni|docker|flannel|kube|lxcbr|lxdbr|podman|vboxnet|veth|virbr|vmnet|vxlan|weave)/;

/**
 * The addresses browsers are told to reach the helper at: the host's private addresses (RFC 1918
 * IPv4 and unique local IPv6), which only devices on its own networks can reach, IPv4 first.
 */
export function lanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === "IPv4" && isPrivateV4(entry.address)) v4.push(entry.address);
      else if (entry.family === "IPv6" && /^f[cd][0-9a-f]{2}:/i.test(entry.address)) v6.push(entry.address);
    }
  }
  return [...new Set([...v4, ...v6])];
}

function isPrivateV4(address: string) {
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Whether the helper may check a browser's candidate at `address`: a .local name (as browsers hide
 * their addresses, found only on the local network), or a private, link-local or loopback address.
 * Anything else would reach beyond the local network.
 */
export function isLocalAddress(address: string) {
  if (/^[0-9a-z][0-9a-z-]*\.local$/i.test(address)) return true;
  if (isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return isPrivateV4(address) || (a === 169 && b === 254) || a === 127;
  }
  return (
    isIPv6(address) && (/^f[cd][0-9a-f]{2}:/i.test(address) || /^fe[89ab][0-9a-f]:/i.test(address) || address === "::1")
  );
}
