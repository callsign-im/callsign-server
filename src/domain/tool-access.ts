import { and, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/client.ts";
import {
  agents,
  conversationMembers,
  conversations,
  mcpConnections,
  mcpConnectionTools,
  mcpGrants,
  mcpShareOptOuts,
  mcpShares,
  type Agent,
  type McpConnection,
  type McpConnectionTool,
  type McpGrant,
  type McpShare,
} from "../db/schema.ts";
import { isExposable, openDefinition, type ToolDefinition } from "./connections.ts";
import { formatGroupName } from "./groups.ts";
import { formatHandle } from "./handles.ts";
import { connectionKey } from "./keys.ts";

const MAX_NAME_LENGTH = 48;

export type ExposedTool = {
  /** What the agent calls it: <slug>__<tool>. */
  name: string;
  tool: string;
  write: boolean;
  definition: ToolDefinition;
  connection: McpConnection;
  via:
    | { kind: "grant"; grant: McpGrant }
    | { kind: "share"; share: McpShare; sharer: Agent; group: string };
};

function toolName(prefix: string, tool: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
  const head = clean(prefix).slice(0, 24);
  return `${head}__${clean(tool)}`.slice(0, MAX_NAME_LENGTH);
}

type Source = {
  connection: McpConnection;
  via: ExposedTool["via"];
  allowed: (name: string) => boolean;
};

async function grantSources(agent: Agent): Promise<Source[]> {
  const rows = await db
    .select({ grant: mcpGrants, connection: mcpConnections })
    .from(mcpGrants)
    .innerJoin(mcpConnections, eq(mcpConnections.id, mcpGrants.connectionId))
    .where(
      and(
        eq(mcpGrants.agentId, agent.id),
        eq(mcpConnections.status, "active"),
        eq(mcpConnections.ownerId, agent.ownerId),
      ),
    );
  return rows.map(({ grant, connection }) => ({
    connection,
    via: { kind: "grant", grant },
    allowed: (name) => grant.tools === null || grant.tools.includes(name),
  }));
}

/**
 * Shares count only while the agent is an active member of the group, the sharing agent still is
 * too and isn't frozen or suspended, the share isn't paused, the connection works and the agent's
 * owner hasn't opted out.
 */
async function shareSources(agent: Agent): Promise<Source[]> {
  if (!agent.sharedTools) return [];
  const sharerMembership = alias(conversationMembers, "sharer_membership");
  const sharer = alias(agents, "sharer");
  const rows = await db
    .select({ share: mcpShares, connection: mcpConnections, sharer, group: conversations.name })
    .from(mcpShares)
    .innerJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, mcpShares.conversationId),
        eq(conversationMembers.agentId, agent.id),
        eq(conversationMembers.status, "active"),
      ),
    )
    .innerJoin(
      sharerMembership,
      and(
        eq(sharerMembership.conversationId, mcpShares.conversationId),
        eq(sharerMembership.agentId, mcpShares.sharerAgentId),
        eq(sharerMembership.status, "active"),
      ),
    )
    .innerJoin(sharer, eq(sharer.id, mcpShares.sharerAgentId))
    .innerJoin(conversations, eq(conversations.id, mcpShares.conversationId))
    .innerJoin(mcpConnections, eq(mcpConnections.id, mcpShares.connectionId))
    .leftJoin(
      mcpShareOptOuts,
      and(eq(mcpShareOptOuts.shareId, mcpShares.id), eq(mcpShareOptOuts.agentId, agent.id)),
    )
    .where(
      and(
        eq(mcpShares.paused, false),
        eq(mcpConnections.status, "active"),
        isNull(sharer.frozenAt),
        isNull(sharer.suspendedAt),
        isNull(mcpShareOptOuts.shareId),
      ),
    );
  return rows.map(({ share, connection, sharer: by, group }) => ({
    connection,
    via: { kind: "share", share, sharer: by, group: formatGroupName(group ?? "") },
    allowed: (name) => share.tools.includes(name),
  }));
}

/** Every connected tool this agent may call right now, by the name it calls it. */
export async function exposedTools(agent: Agent): Promise<ExposedTool[]> {
  const [grants, shares] = await Promise.all([grantSources(agent), shareSources(agent)]);
  const sources = [...grants, ...shares];
  if (sources.length === 0) return [];

  const connectionIds = [...new Set(sources.map((source) => source.connection.id))];
  const rows = await db
    .select()
    .from(mcpConnectionTools)
    .where(inArray(mcpConnectionTools.connectionId, connectionIds));
  const byConnection = new Map<string, McpConnectionTool[]>();
  for (const row of rows.filter(isExposable)) {
    byConnection.set(row.connectionId, [...(byConnection.get(row.connectionId) ?? []), row]);
  }

  const out: ExposedTool[] = [];
  const names = new Set<string>();
  const covered = new Set<string>();
  for (const source of sources) {
    const tools = (byConnection.get(source.connection.id) ?? []).filter((row) =>
      source.allowed(row.name),
    );
    if (tools.length === 0) continue;
    const key = await connectionKey(source.connection);
    const readOnly = source.via.kind === "grant" && source.via.grant.access === "read";
    for (const row of tools) {
      if (readOnly && row.write) continue;
      // A tool the agent already reaches through its own owner's grant isn't listed twice.
      const identity = `${source.connection.id}:${row.name}`;
      if (covered.has(identity)) continue;
      covered.add(identity);
      let name = toolName(source.connection.slug, row.name);
      if (names.has(name) && source.via.kind === "share") {
        name = toolName(`${source.connection.slug}_${source.via.sharer.handle}`, row.name);
      }
      if (names.has(name)) continue;
      names.add(name);
      out.push({
        name,
        tool: row.name,
        write: row.write,
        definition: openDefinition(key, row),
        connection: source.connection,
        via: source.via,
      });
    }
  }
  return out;
}

export async function resolveTool(agent: Agent, name: string): Promise<ExposedTool | null> {
  return (await exposedTools(agent)).find((tool) => tool.name === name) ?? null;
}

export type ExposedToolView = {
  name: string;
  title: string | null;
  description: string | null;
  write: boolean;
  connection: string;
  sharedBy: string | null;
  group: string | null;
  inputSchema: Record<string, unknown>;
};

export function exposedView(tool: ExposedTool): ExposedToolView {
  return {
    name: tool.name,
    title: tool.definition.title ?? null,
    description: tool.definition.description ?? null,
    write: tool.write,
    connection: tool.connection.name,
    sharedBy: tool.via.kind === "share" ? formatHandle(tool.via.sharer.handle) : null,
    group: tool.via.kind === "share" ? tool.via.group : null,
    inputSchema: tool.definition.inputSchema,
  };
}
