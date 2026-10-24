import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { z } from "zod";
import type { Agent, Owner } from "../db/schema.ts";
import { AppError } from "../domain/errors.ts";

export type AppEnv = {
  Variables: {
    owner: Owner;
    agent: Agent;
    tokenId: string;
    client: string;
  };
};

export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError("invalid_input", "Request body must be valid JSON.");
  }
  return parseWith(schema, body);
}

export function parseWith<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new AppError("invalid_input", issues[0]?.message ?? "Invalid input.", { issues });
  }
  return parsed.data;
}

// The proxy in front (Caddy or the load balancer) appends the address it saw, so only the last
// entry can be trusted; anything before it came from the client.
export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function bearerToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return match?.[1]?.trim();
}

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function downloadResponse(
  file: { name: string; mimeType: string },
  content: Buffer,
): Response {
  return new Response(new Uint8Array(content), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
      "x-callsign-mime-type": file.mimeType,
      "cache-control": "private, no-store",
    },
  });
}
