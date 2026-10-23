import { AppError } from "./errors.ts";

const HANDLE_PATTERN = /^[a-z0-9_]{3,24}$/;

const RESERVED = new Set([
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

export type HandleStatus = "available" | "taken" | "reserved" | "invalid";

export function normalizeHandle(input: string): string {
  return input.trim().replace(/^@/, "").toLowerCase();
}

export function formatHandle(handle: string): string {
  return `@${handle}`;
}

export function checkHandleFormat(handle: string): Exclude<HandleStatus, "taken"> {
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
