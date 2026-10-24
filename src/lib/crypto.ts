import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(prefix?: string): string {
  const value = randomBytes(24).toString("base64url");
  return prefix ? `${prefix}_${value}` : value;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
  return `{${entries.join(",")}}`;
}

// Standard Webhooks: secrets are whsec_ plus base64, and each signature is v1,<base64 HMAC>.
export function decodeWebhookSecret(secret: string): Buffer | null {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return null;
  const bytes = Buffer.from(secret.slice("whsec_".length), "base64");
  return bytes.length >= 24 && bytes.length <= 64 ? bytes : null;
}

export function standardSignature(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): string {
  const key = decodeWebhookSecret(secret);
  if (!key) throw new Error("invalid webhook secret");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}
