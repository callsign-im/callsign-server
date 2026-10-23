import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().optional(),
  PGSSLMODE: z.enum(["disable", "allow", "prefer", "require", "verify-full"]).optional(),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  PUBLIC_API_URL: z.url().default("http://localhost:8080"),
  WEB_URL: z.url().default("http://localhost:3000"),
  SMTP_URL: z.string().default("smtp://localhost:1025"),
  MAIL_FROM: z.string().default("Callsign <no-reply@callsign.local>"),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

export const isProduction = config.NODE_ENV === "production";
export const usesHttps = config.PUBLIC_API_URL.startsWith("https://");
