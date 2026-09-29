import { isIP } from "node:net";
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

/** RELAY_LOCAL_ADDRESSES: addresses to announce instead, for a helper whose own interfaces aren't the host's. */
export function parseAddresses(value: string): string[] {
  const addresses = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const address of addresses)
    if (!isIP(address)) throw new Error(`RELAY_LOCAL_ADDRESSES must list IP addresses; "${address}" is not one.`);
  if (!addresses.length) throw new Error("RELAY_LOCAL_ADDRESSES must list at least one IP address.");
  return [...new Set(addresses)];
}
