import { randomBytes } from "node:crypto";

export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
