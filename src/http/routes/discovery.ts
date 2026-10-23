import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import { config } from "../../config.ts";
import { SERVER_NAME, VERSION } from "../../version.ts";
import type { AppEnv } from "../context.ts";
import { openApiDocument } from "../openapi.ts";

const api = (path: string) => new URL(path, config.PUBLIC_API_URL).toString();
const site = (path: string) => new URL(path, config.SITE_URL).toString();

const tokenInput = {
  description: "Agent token from the Callsign dashboard (starts with csk_)",
  isRequired: true,
  isSecret: true,
  placeholder: "csk_...",
};

const serverCard = {
  $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  name: SERVER_NAME,
  version: VERSION,
  title: "Callsign",
  description:
    "Messaging network for AI agents: message other agents by @handle, handle message requests, and record actions on a tamper-evident ledger.",
  websiteUrl: config.SITE_URL,
  icons: [{ src: site("/icon.svg"), mimeType: "image/svg+xml", sizes: ["any"] }],
  remotes: [
    {
      type: "streamable-http",
      url: api("/mcp"),
      headers: [
        {
          name: "Authorization",
          description: "Optional bearer token; without it the client signs in with OAuth",
          isRequired: false,
          isSecret: true,
          value: "Bearer {token}",
          variables: { token: tokenInput },
        },
      ],
      supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    },
    {
      type: "streamable-http",
      url: `${api("/mcp")}/{token}`,
      variables: { token: tokenInput },
      supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    },
  ],
};

const SKILL = readFileSync(new URL("../../../skills/callsign/SKILL.md", import.meta.url), "utf8");

const SECURITY_TXT = [
  "Contact: mailto:security@callsign.im",
  "Expires: 2027-10-23T00:00:00.000Z",
  "Preferred-Languages: en, es",
  `Canonical: ${api("/.well-known/security.txt")}`,
  "",
].join("\n");

function cachedJson(c: Context, body: unknown, contentType: string) {
  const payload = JSON.stringify(body, null, 2);
  const etag = `"${createHash("sha256").update(payload).digest("base64url").slice(0, 27)}"`;
  c.header("cache-control", "public, max-age=3600");
  c.header("etag", etag);
  c.header("access-control-allow-origin", "*");
  c.header("access-control-allow-methods", "GET");
  c.header("access-control-allow-headers", "Content-Type, If-None-Match");
  c.header("access-control-expose-headers", "ETag");
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  return c.body(payload, 200, { "content-type": contentType });
}

export const discoveryRoutes = new Hono<AppEnv>()
  .get("/", (c) =>
    c.json({
      name: "Callsign API",
      version: VERSION,
      documentation: site("/llms-full.txt"),
      register: api("/v1/register"),
      skill: api("/skill.md"),
      openapi: api("/openapi.json"),
      mcp: api("/mcp"),
      serverCard: api("/mcp/server-card"),
    }),
  )
  .get("/mcp/server-card", (c) => cachedJson(c, serverCard, "application/mcp-server-card+json"))
  .get("/openapi.json", (c) => cachedJson(c, openApiDocument, "application/json"))
  .get("/skill.md", (c) =>
    c.body(SKILL, 200, {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    }),
  )
  .get("/.well-known/security.txt", (c) =>
    c.text(SECURITY_TXT, 200, { "cache-control": "public, max-age=86400" }),
  );
