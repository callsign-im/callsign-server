import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, Transform } from "node:stream";
import { isPublicHost, publicLookup } from "./safe-fetch.ts";

export type SafeFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

const NO_BODY = new Set([101, 204, 205, 304]);

function bodyOf(init: RequestInit | undefined): Buffer | undefined {
  const body = init?.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("unsupported request body");
}

function headersOf(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

/**
 * A fetch for servers someone else runs: it only reaches public addresses (checked at connect
 * time, so DNS rebinding can't get around it), never follows redirects, and stops reading a
 * response past `maxBytes`. Responses stream, so server-sent events work.
 */
export function createSafeFetch({
  allowPrivate = false,
  maxBytes = 8 * 1024 * 1024,
  idleTimeoutMs = 30_000,
}: { allowPrivate?: boolean; maxBytes?: number; idleTimeoutMs?: number } = {}): SafeFetch {
  return (input, init) => {
    const url = new URL(input.toString());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return Promise.reject(new TypeError(`unsupported protocol ${url.protocol}`));
    }
    if (!allowPrivate && !isPublicHost(url)) {
      return Promise.reject(new TypeError(`${url.hostname} is not a public address`));
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = bodyOf(init);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const signal = init?.signal ?? undefined;

    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason as Error);
        return;
      }
      const req = send(
        url,
        {
          method: init?.method ?? "GET",
          headers,
          timeout: idleTimeoutMs,
          ...(!allowPrivate && { lookup: publicLookup }),
        },
        (res) => {
          let received = 0;
          const capped = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              received += chunk.length;
              done(received > maxBytes ? new Error("response is too large") : null, chunk);
            },
          });
          res.on("error", (error) => capped.destroy(error));
          const status = res.statusCode ?? 0;
          const stream = NO_BODY.has(status)
            ? null
            : (Readable.toWeb(res.pipe(capped)) as ReadableStream<Uint8Array>);
          resolve(
            new Response(stream, {
              status,
              statusText: res.statusMessage,
              headers: headersOf(res),
            }),
          );
        },
      );
      const abort = () => req.destroy(signal?.reason as Error);
      signal?.addEventListener("abort", abort, { once: true });
      req.on("close", () => signal?.removeEventListener("abort", abort));
      req.on("timeout", () => req.destroy(new Error(`request to ${url.host} timed out`)));
      req.on("error", reject);
      req.end(body);
    });
  };
}
