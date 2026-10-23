import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;

// Separate lists, because a BlockList with IPv6 rules also matches IPv4 addresses mapped into them.
const reservedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  reservedV4.addSubnet(network, prefix, "ipv4");
}

const reservedV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  reservedV6.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !reservedV4.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  if (/^::ffff:/i.test(address)) return false;
  return !reservedV6.check(address, "ipv6");
}

// Resolves once and connects to the checked address, so DNS rebinding can't reach internal hosts.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true }).then(
    (addresses) => {
      const usable = addresses.filter((entry) => isPublicAddress(entry.address));
      const first = usable[0];
      if (!first || usable.length !== addresses.length) {
        callback(new Error(`${hostname} does not resolve to a public address`), "", 4);
      } else if (options.all) {
        (callback as unknown as (err: null, list: typeof usable) => void)(null, usable);
      } else {
        callback(null, first.address, first.family);
      }
    },
    (error: NodeJS.ErrnoException) => callback(error, "", 4),
  );
};

export type PublicJson = { body: unknown; maxAge: number | null };

export function fetchPublicJson(url: URL): Promise<PublicJson> {
  if (url.protocol !== "https:") return Promise.reject(new Error("only https URLs are fetched"));
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        lookup: publicLookup,
        timeout: TIMEOUT_MS,
        headers: { accept: "application/json" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`metadata request returned ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error("metadata document is too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            const maxAge = /max-age=(\d+)/.exec(res.headers["cache-control"] ?? "")?.[1];
            resolve({
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              maxAge: maxAge ? Number(maxAge) : null,
            });
          } catch {
            reject(new Error("metadata document is not valid JSON"));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("metadata request timed out")));
    req.on("error", reject);
    req.end();
  });
}
