import { BlockList, isIP } from "node:net";
import { open, type AsnResponse, type Reader } from "maxmind";
import { config } from "../config.ts";
import { logger } from "./logger.ts";

/** What an IP address is grouped under for "new network" alerts. `id` is stable, `label` is shown. */
export type Network = { id: string; label: string };

const privateRanges = new BlockList();
for (const [address, prefix] of [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  privateRanges.addSubnet(address, prefix, "ipv4");
}
privateRanges.addSubnet("fc00::", 7, "ipv6");
privateRanges.addSubnet("fe80::", 10, "ipv6");
privateRanges.addAddress("::1", "ipv6");

let reader: Promise<Reader<AsnResponse> | null> | undefined;

// The ASN database is optional and read locally: addresses are never sent to a lookup service.
function asnReader(): Promise<Reader<AsnResponse> | null> {
  const path = config.ASN_DATABASE;
  reader ??= path
    ? open<AsnResponse>(path).catch((err: unknown) => {
        logger.error({ err, path }, "couldn't open ASN_DATABASE, grouping by address prefix");
        return null;
      })
    : Promise.resolve(null);
  return reader;
}

/** Returns the canonical form of an address, or null when it isn't one. */
export function normalizeIp(raw: string): string | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw)?.[1];
  const ip = mapped ?? raw;
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version === 6) return expandIpv6(ip).join(":");
  return null;
}

function expandIpv6(ip: string): string[] {
  const [head = "", tail] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return groups.map((group) => group.padStart(4, "0"));
}

function prefixOf(ip: string): Network {
  if (isIP(ip) === 4) {
    const prefix = `${ip.split(".").slice(0, 3).join(".")}.0/24`;
    return { id: `v4:${prefix}`, label: prefix };
  }
  const groups = ip.split(":").slice(0, 3);
  const label = `${groups.map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/48`;
  return { id: `v6:${groups.join(":")}::/48`, label };
}

export async function networkOf(ip: string): Promise<Network> {
  if (privateRanges.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6")) {
    return { id: "private", label: "Private network" };
  }
  const asn = (await asnReader())?.get(ip);
  if (asn?.autonomous_system_number) {
    const number = asn.autonomous_system_number;
    const name = asn.autonomous_system_organization;
    return { id: `as:${number}`, label: name ? `AS${number} ${name}` : `AS${number}` };
  }
  return prefixOf(ip);
}
