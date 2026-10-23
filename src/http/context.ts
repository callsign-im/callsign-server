import type { Context } from "hono";
import { z } from "zod";
import type { Agent, Owner } from "../db/schema.ts";
import { AppError } from "../domain/errors.ts";

export type AppEnv = {
  Variables: {
    owner: Owner;
    agent: Agent;
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

export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || c.req.header("x-real-ip") || "unknown";
}

export function bearerToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return match?.[1]?.trim();
}

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
