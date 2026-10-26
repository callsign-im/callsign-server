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
  APP_URL: z.url().default("http://localhost:3001"),
  SITE_URL: z.url().default("http://localhost:3000"),
  SMTP_URL: z.string().default("smtp://localhost:1025"),
  MAIL_FROM: z.string().default("Callsign <no-reply@callsign.local>"),
  KMS_KEY_ID: z.string().min(1).optional(),
  ENCRYPTION_KEY: z.base64().optional(),
  ALLOW_PRIVATE_WEBHOOKS: z.stringbool().default(false),
  // Passkeys are bound to this domain forever. Defaults to the website's domain when the
  // dashboard is one of its subdomains, otherwise to the dashboard's host.
  WEBAUTHN_RP_ID: z
    .string()
    .optional()
    .transform((id) => id?.trim().toLowerCase() || undefined),
  WEBAUTHN_RP_NAME: z.string().default("Callsign"),
  WEBAUTHN_EXTRA_ORIGINS: z
    .string()
    .default("")
    .transform((raw) =>
      raw
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  // A MaxMind-format ASN database (GeoLite2-ASN or DB-IP ASN Lite). Without it, networks are /24 or /48 prefixes.
  ASN_DATABASE: z
    .string()
    .optional()
    .transform((path) => path || undefined),
  SUPPORT_EMAIL: z.email().optional(),
  TELEGRAM_BOT_TOKEN: z
    .string()
    .optional()
    .transform((token) => token || undefined),
  TELEGRAM_API_URL: z.url().default("https://api.telegram.org"),
  EMAIL_BRIDGE_DOMAIN: z
    .string()
    .optional()
    .transform((domain) => domain?.trim().toLowerCase() || undefined),
  RESEND_API_KEY: z
    .string()
    .optional()
    .transform((key) => key || undefined),
  RESEND_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((secret) => secret || undefined),
  RESEND_API_URL: z.url().default("https://api.resend.com"),
  ADMIN_EMAILS: z
    .string()
    .default("")
    .transform((raw) =>
      raw
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

export const isProduction = config.NODE_ENV === "production";
export const usesHttps = config.PUBLIC_API_URL.startsWith("https://");
export const siteDomain = new URL(config.SITE_URL).hostname.replace(/^www\./, "");
export const supportEmail = config.SUPPORT_EMAIL ?? `support@${siteDomain}`;
