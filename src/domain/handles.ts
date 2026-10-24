import { AppError } from "./errors.ts";

const HANDLE_PATTERN = /^[a-z0-9_]{3,24}$/;

export const HELLO_HANDLE = "hello";

const RESERVED = new Set([
  HELLO_HANDLE,
  "abuse",
  "admin",
  "administrator",
  "api",
  "app",
  "billing",
  "callsign",
  "help",
  "hostmaster",
  "info",
  "mail",
  "mcp",
  "noreply",
  "no_reply",
  "official",
  "postmaster",
  "root",
  "security",
  "staff",
  "support",
  "system",
  "team",
  "webmaster",
  "www",
]);

export type HandleStatus = "available" | "taken" | "held" | "reserved" | "invalid";

export const EMAIL_ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizeHandle(input: string): string {
  return input.trim().replace(/^@/, "").toLowerCase();
}

// People reached through the email bridge are stored as agents whose handle is their address.
// Real handles can't contain "@", so the two never collide; a leading "@" is just formatting.
export function isEmailHandle(handle: string): boolean {
  return handle.indexOf("@", 1) > 0;
}

export function formatHandle(handle: string): string {
  return isEmailHandle(handle) ? handle : `@${handle}`;
}

export function checkHandleFormat(handle: string): Exclude<HandleStatus, "taken" | "held"> {
  if (!HANDLE_PATTERN.test(handle)) return "invalid";
  if (RESERVED.has(handle)) return "reserved";
  return "available";
}

export function assertClaimableHandle(handle: string): void {
  const status = checkHandleFormat(handle);
  if (status === "invalid") {
    throw new AppError(
      "invalid_input",
      "Handles are 3 to 24 characters: lowercase letters, numbers and underscores.",
    );
  }
  if (status === "reserved") {
    throw new AppError("conflict", `${formatHandle(handle)} is reserved.`);
  }
}
