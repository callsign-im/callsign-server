import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import type { Agent } from "../../db/schema.ts";
import { agentRules } from "../../domain/agents.ts";
import { AppError } from "../../domain/errors.ts";
import { OAUTH_SCOPE, resourceMetadataUrl } from "../../domain/oauth.ts";
import { logger } from "../../lib/logger.ts";
import { buildMcpServer } from "../../mcp/server.ts";
import { agentCredential } from "../auth.ts";
import { bearerToken, type AppEnv } from "../context.ts";

type Session = { agent: Agent; tokenId: string; rules: string | null };

const handler = createMcpHandler(
  ({ authInfo }) => {
    const session = authInfo?.extra?.session as Session | undefined;
    if (!session) throw new Error("MCP request reached the server without an authenticated agent");
    return buildMcpServer(session.agent, session.rules, session.tokenId);
  },
  {
    legacy: "stateless",
    onerror: (err) => logger.warn({ err }, "mcp request error"),
  },
);

function rejected(c: Context, error: AppError, tokenSent: boolean) {
  const status = error.status === 403 ? 403 : 401;
  const challenge = [
    `resource_metadata="${resourceMetadataUrl}"`,
    `scope="${OAUTH_SCOPE}"`,
    ...(status === 401 && tokenSent ? ['error="invalid_token"'] : []),
  ];
  return c.json(
    { jsonrpc: "2.0", error: { code: -32001, message: error.message }, id: null },
    status,
    { "www-authenticate": `Bearer ${challenge.join(", ")}` },
  );
}

async function serve(c: Context, token: string | undefined) {
  let credential: { agent: Agent; tokenId: string };
  try {
    credential = await agentCredential(token);
  } catch (error) {
    if (error instanceof AppError) return rejected(c, error, token !== undefined);
    throw error;
  }
  const { agent, tokenId } = credential;
  const session: Session = { agent, tokenId, rules: await agentRules(agent) };
  return handler.fetch(c.req.raw, {
    authInfo: { token: "redacted", clientId: agent.id, scopes: ["agent"], extra: { session } },
  });
}

export const mcpRoutes = new Hono<AppEnv>()
  .all("/mcp", (c) => serve(c, bearerToken(c)))
  .all("/mcp/:token", (c) => serve(c, c.req.param("token")));

export async function closeMcp(): Promise<void> {
  await handler.close();
}
