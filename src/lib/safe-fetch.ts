import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
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

function isLocalName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

export function isPublicHost(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isLocalName(host)) return false;
  return isIP(host) === 0 || isPublicAddress(host);
}

type Response = { status: number; headers: IncomingHttpHeaders; body: Buffer };

// Node skips the lookup for IP literals, so those are checked up front; redirects are never followed.
function send(
  url: URL,
  options: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  { allowPrivate = false, timeoutMs = TIMEOUT_MS } = {},
): Promise<Response> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Promise.reject(new Error(`unsupported protocol ${url.protocol}`));
  }
  if (!allowPrivate && !isPublicHost(url)) {
    return Promise.reject(new Error(`${url.hostname} is not a public address`));
  }
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: options.method,
        headers: options.headers,
        timeout: timeoutMs,
        ...(!allowPrivate && { lookup: publicLookup }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error("response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`request to ${url.host} timed out`)));
    req.on("error", reject);
    req.end(options.body);
  });
}

export type PublicJson = { body: unknown; maxAge: number | null };

export async function fetchPublicJson(url: URL): Promise<PublicJson> {
  if (url.protocol !== "https:") throw new Error("only https URLs are fetched");
  const res = await send(url, { method: "GET", headers: { accept: "application/json" } });
  if (res.status !== 200) throw new Error(`metadata request returned ${res.status}`);
  const maxAge = /max-age=(\d+)/.exec(res.headers["cache-control"] ?? "")?.[1];
  try {
    return { body: JSON.parse(res.body.toString("utf8")), maxAge: maxAge ? Number(maxAge) : null };
  } catch {
    throw new Error("metadata document is not valid JSON");
  }
}

export async function postJson(
  url: URL,
  body: string,
  headers: Record<string, string>,
  options: { allowPrivate: boolean; timeoutMs: number },
): Promise<{ status: number; body: string }> {
  const res = await send(
    url,
    { method: "POST", headers: { ...headers, "content-type": "application/json" }, body },
    options,
  );
  return { status: res.status, body: res.body.toString("utf8") };
}
