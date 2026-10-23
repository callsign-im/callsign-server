import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import type { Agent } from "../../db/schema.ts";
import { authenticateAgentToken } from "../../domain/agents.ts";
import { logger } from "../../lib/logger.ts";
import { buildMcpServer } from "../../mcp/server.ts";
import { bearerToken, type AppEnv } from "../context.ts";

const handler = createMcpHandler(
  ({ authInfo }) => {
    const agent = authInfo?.extra?.agent as Agent | undefined;
    if (!agent) throw new Error("MCP request reached the server without an authenticated agent");
    return buildMcpServer(agent);
  },
  {
    legacy: "stateless",
    onerror: (err) => logger.warn({ err }, "mcp request error"),
  },
);

function unauthorized(c: Context) {
  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message: "A valid Callsign agent token is required." },
      id: null,
    },
    401,
    { "www-authenticate": 'Bearer realm="callsign"' },
  );
}

async function serve(c: Context, token: string | undefined) {
  const agent = token ? await authenticateAgentToken(token) : null;
  if (!agent) return unauthorized(c);
  return handler.fetch(c.req.raw, {
    authInfo: { token: "redacted", clientId: agent.id, scopes: ["agent"], extra: { agent } },
  });
}

export const mcpRoutes = new Hono<AppEnv>()
  .all("/mcp", (c) => serve(c, bearerToken(c)))
  .all("/mcp/:token", (c) => serve(c, c.req.param("token")));

export async function closeMcp(): Promise<void> {
  await handler.close();
}
