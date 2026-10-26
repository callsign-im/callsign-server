import { and, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import {
  agents,
  conversationMembers,
  conversations,
  mcpCalls,
  mcpConnections,
  mcpConnectionTools,
  mcpGrants,
  mcpShareOptOuts,
  mcpShares,
  owners,
  type Agent,
  type McpConnection,
  type McpConnectionTool,
  type Owner,
  type ShareApproval,
  type ToolAccess,
} from "../db/schema.ts";
import { enqueue } from "../jobs/queue.ts";
import { canonicalJson, sha256 } from "../lib/crypto.ts";
import type { DataKey } from "../lib/encryption.ts";
import { uuidv7 } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { isPublicHost } from "../lib/safe-fetch.ts";
import { getOwnedAgent } from "./agents.ts";
import {
  isReauthError,
  readCredentials,
  sealCredentials,
  startConnectionAuth,
  withUpstream,
  type HeaderSecret,
} from "./connection-auth.ts";
import { AppError, isUniqueViolation } from "./errors.ts";
import { formatGroupName, normalizeGroupName } from "./groups.ts";
import { formatHandle } from "./handles.ts";
import { connectionKey, newConnectionKey } from "./keys.ts";
import { broadcast, type RecordedEvent } from "./ledger.ts";
import { createNotice } from "./notices.ts";
import type { OwnerSession } from "./owners.ts";
import { assertStepUp } from "./passkeys.ts";

export const MAX_CONNECTIONS = 10;
export const MAX_SHARES = 10;
const MAX_TOOLS = 200;
const MAX_DEFINITION_BYTES = 32 * 1024;
const FAILURES_BEFORE_ERROR = 3;
const STALE_SYNC_MS = 6 * 3_600_000;

// Headers that would let a connection impersonate Callsign's own transport or the request.
const RESERVED_HEADER = /^(host|cookie|content-.*|mcp-.*|connection|transfer-encoding|accept)$/i;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

export type ToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

const definitionContext = (connectionId: string, name: string) =>
  `mcp_connection_tools.definition:${connectionId}:${name}`;

export function openDefinition(key: DataKey, row: McpConnectionTool): ToolDefinition {
  return JSON.parse(
    key.open(row.definition, definitionContext(row.connectionId, row.name)),
  ) as ToolDefinition;
}

/** Short, stable names for tools: <slug>__<tool>. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 16)
    .replace(/_+$/g, "");
  return slug || "tools";
}

function cleanServerUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError("invalid_input", "That isn't a valid server URL.");
  }
  if (url.protocol !== "https:" && !(config.ALLOW_PRIVATE_TOOLS && url.protocol === "http:")) {
    throw new AppError("invalid_input", "MCP servers must use https.");
  }
  if (!config.ALLOW_PRIVATE_TOOLS && !isPublicHost(url)) {
    throw new AppError("invalid_input", "That server isn't on a public address.");
  }
  if (url.username || url.password) {
    throw new AppError("invalid_input", "Put credentials in a header, not in the URL.");
  }
  url.hash = "";
  return url;
}

function cleanHeader(header: HeaderSecret): HeaderSecret {
  const name = header.name.trim();
  if (!HEADER_NAME.test(name) || RESERVED_HEADER.test(name)) {
    throw new AppError("invalid_input", `${name || "That"} can't be used as the auth header.`);
  }
  const value = header.value.trim();
  if (!value || value.length > 4096 || /[\r\n]/.test(value)) {
    throw new AppError("invalid_input", "The header value is empty or too long.");
  }
  return { name, value };
}

export const connectionInput = z.object({
  name: z.string().trim().min(1).max(60),
  serverUrl: z.string().min(1).max(2048),
  auth: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("oauth") }),
    z.object({ kind: z.literal("none") }),
    z.object({
      kind: z.literal("header"),
      header: z.string().min(1).max(64),
      value: z.string().min(1).max(4096),
    }),
  ]),
});

async function ownedConnection(ownerId: string, id: string): Promise<McpConnection> {
  const [row] = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.ownerId, ownerId)));
  if (!row) throw new AppError("not_found", "No connection with that id.");
  return row;
}

async function uniqueSlug(ownerId: string, name: string): Promise<string> {
  const base = slugify(name);
  const taken = new Set(
    (
      await db
        .select({ slug: mcpConnections.slug })
        .from(mcpConnections)
        .where(eq(mcpConnections.ownerId, ownerId))
    ).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base.slice(0, 13)}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function createConnection(
  owner: Owner,
  input: z.infer<typeof connectionInput>,
): Promise<{ connection: McpConnection; authorizationUrl: string | null }> {
  const url = cleanServerUrl(input.serverUrl);
  const [existing] = await db
    .select({ total: count() })
    .from(mcpConnections)
    .where(eq(mcpConnections.ownerId, owner.id));
  if ((existing?.total ?? 0) >= MAX_CONNECTIONS) {
    throw new AppError("conflict", `You can connect up to ${MAX_CONNECTIONS} servers.`);
  }
  const id = uuidv7();
  const dataKey = await newConnectionKey(id);
  const key = await connectionKey({ id, dataKey });
  const header =
    input.auth.kind === "header"
      ? cleanHeader({ name: input.auth.header, value: input.auth.value })
      : null;
  let connection: McpConnection | undefined;
  try {
    [connection] = await db
      .insert(mcpConnections)
      .values({
        id,
        ownerId: owner.id,
        name: input.name,
        slug: await uniqueSlug(owner.id, input.name),
        serverUrl: url.toString(),
        authKind: input.auth.kind,
        dataKey,
        credentials: header ? sealCredentials(key, id, { header }) : null,
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("conflict", "Try again with another name.");
    throw error;
  }
  if (!connection) throw new Error("connection insert returned no row");
  if (input.auth.kind === "oauth") {
    const authorizationUrl = await startConnectionAuth(connection);
    if (authorizationUrl) return { connection, authorizationUrl: authorizationUrl.toString() };
  }
  return { connection: await syncConnection({ connectionId: id }), authorizationUrl: null };
}

export async function reconnect(owner: Owner, id: string): Promise<string | null> {
  const connection = await ownedConnection(owner.id, id);
  if (connection.authKind !== "oauth") {
    await syncConnection({ connectionId: id });
    return null;
  }
  const url = await startConnectionAuth(connection);
  if (!url) await syncConnection({ connectionId: id });
  return url?.toString() ?? null;
}

export async function updateConnection(
  owner: Owner,
  session: OwnerSession,
  id: string,
  input: { name?: string | undefined; header?: HeaderSecret | undefined },
): Promise<McpConnection> {
  const connection = await ownedConnection(owner.id, id);
  const key = await connectionKey(connection);
  if (input.header) {
    if (connection.authKind !== "header") {
      throw new AppError("invalid_input", "This connection doesn't use a header.");
    }
    await assertStepUp(owner.id, session);
  }
  const [updated] = await db
    .update(mcpConnections)
    .set({
      ...(input.name && { name: input.name.trim().slice(0, 60) }),
      ...(input.header && {
        credentials: sealCredentials(key, id, { header: cleanHeader(input.header) }),
        credentialsVersion: sql`${mcpConnections.credentialsVersion} + 1`,
      }),
    })
    .where(eq(mcpConnections.id, id))
    .returning();
  if (input.header) await enqueue(db, "connection.sync", { connectionId: id });
  return updated ?? connection;
}

export async function deleteConnection(owner: Owner, id: string): Promise<void> {
  await ownedConnection(owner.id, id);
  await db.delete(mcpConnections).where(eq(mcpConnections.id, id));
}

// ---- tools -----------------------------------------------------------------------------------

function toDefinition(tool: {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown> | undefined;
}): ToolDefinition {
  return {
    name: tool.name,
    ...(tool.title && { title: tool.title }),
    ...(tool.description && { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.annotations && { annotations: tool.annotations }),
  };
}

/**
 * Reads the server's tools and compares them with what the owner approved. New tools stay off,
 * and a tool whose definition changed is hidden until the owner approves it again, so a server
 * can't quietly turn a harmless tool into something else.
 */
export async function syncConnection({
  connectionId,
}: {
  connectionId: string;
}): Promise<McpConnection> {
  const [connection] = await db
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.id, connectionId));
  if (!connection) throw new AppError("not_found", "No connection with that id.");
  const key = await connectionKey(connection);
  try {
    const listed = await withUpstream(connection, async (client) => {
      const all: ToolDefinition[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        all.push(
          ...page.tools.map((tool) => toDefinition(tool as Parameters<typeof toDefinition>[0])),
        );
        cursor = page.nextCursor;
      } while (cursor && all.length < MAX_TOOLS);
      return all.slice(0, MAX_TOOLS);
    });
    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(mcpConnectionTools)
        .where(eq(mcpConnectionTools.connectionId, connectionId));
      const known = new Map(rows.map((row) => [row.name, row]));
      const seen = new Set<string>();
      for (const definition of listed) {
        const json = canonicalJson(definition);
        if (Buffer.byteLength(json) > MAX_DEFINITION_BYTES || seen.has(definition.name)) continue;
        seen.add(definition.name);
        const hash = sha256(json);
        const row = known.get(definition.name);
        const sealed = key.seal(json, definitionContext(connectionId, definition.name));
        const write = definition.annotations?.readOnlyHint !== true;
        if (!row) {
          await tx.insert(mcpConnectionTools).values({
            connectionId,
            name: definition.name,
            definition: sealed,
            definitionHash: hash,
            write,
            status: "new",
          });
          continue;
        }
        const status = !row.approvedHash ? "new" : row.approvedHash === hash ? "active" : "changed";
        await tx
          .update(mcpConnectionTools)
          .set({ definition: sealed, definitionHash: hash, status, updatedAt: new Date() })
          .where(
            and(
              eq(mcpConnectionTools.connectionId, connectionId),
              eq(mcpConnectionTools.name, definition.name),
            ),
          );
      }
      const gone = rows.filter((row) => !seen.has(row.name) && row.status !== "removed");
      if (gone.length > 0) {
        await tx
          .update(mcpConnectionTools)
          .set({ status: "removed", updatedAt: new Date() })
          .where(
            and(
              eq(mcpConnectionTools.connectionId, connectionId),
              inArray(
                mcpConnectionTools.name,
                gone.map((row) => row.name),
              ),
            ),
          );
      }
    });
    const [synced] = await db
      .update(mcpConnections)
      .set({ status: "active", lastError: null, syncFailures: 0, toolsSyncedAt: new Date() })
      .where(eq(mcpConnections.id, connectionId))
      .returning();
    return synced ?? connection;
  } catch (error) {
    const reauth = isReauthError(error);
    const message = error instanceof Error ? error.message : "The server didn't answer.";
    logger.info({ err: error, connectionId }, "connection sync failed");
    const failures = connection.syncFailures + 1;
    const [failed] = await db
      .update(mcpConnections)
      .set({
        syncFailures: failures,
        lastError: message.slice(0, 500),
        status: reauth
          ? "needs_reauth"
          : failures >= FAILURES_BEFORE_ERROR || connection.status === "pending"
            ? "error"
            : connection.status,
      })
      .where(eq(mcpConnections.id, connectionId))
      .returning();
    return failed ?? connection;
  }
}

export async function syncStaleConnections(): Promise<void> {
  const stale = await db
    .select({ id: mcpConnections.id })
    .from(mcpConnections)
    .where(
      and(
        inArray(mcpConnections.status, ["active", "error"]),
        or(
          sql`${mcpConnections.toolsSyncedAt} is null`,
          lt(mcpConnections.toolsSyncedAt, new Date(Date.now() - STALE_SYNC_MS)),
        ),
      ),
    );
  for (const { id } of stale) await enqueue(db, "connection.sync", { connectionId: id });
}

export async function updateTool(
  owner: Owner,
  session: OwnerSession,
  connectionId: string,
  name: string,
  input: { enabled?: boolean | undefined; write?: boolean | undefined },
): Promise<void> {
  await ownedConnection(owner.id, connectionId);
  const [tool] = await db
    .select()
    .from(mcpConnectionTools)
    .where(
      and(eq(mcpConnectionTools.connectionId, connectionId), eq(mcpConnectionTools.name, name)),
    );
  if (!tool) throw new AppError("not_found", `This server has no tool called ${name}.`);
  // Turning on a tool that can change things, or calling one read-only, needs a passkey.
  const writes = input.write ?? tool.write;
  if ((input.enabled === true && writes) || (input.write === false && tool.write)) {
    await assertStepUp(owner.id, session);
  }
  await db
    .update(mcpConnectionTools)
    .set({
      ...(input.write !== undefined && { write: input.write }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      // Enabling approves exactly the definition the owner is looking at.
      ...(input.enabled === true && {
        approvedHash: tool.definitionHash,
        status: tool.status === "removed" ? "removed" : "active",
      }),
      updatedAt: new Date(),
    })
    .where(
      and(eq(mcpConnectionTools.connectionId, connectionId), eq(mcpConnectionTools.name, name)),
    );
}

// ---- grants and shares -----------------------------------------------------------------------

export async function putGrant(
  owner: Owner,
  session: OwnerSession,
  connectionId: string,
  handle: string,
  input: { access: ToolAccess; tools?: string[] | null | undefined },
): Promise<void> {
  await ownedConnection(owner.id, connectionId);
  const agent = await getOwnedAgent(owner.id, handle);
  if (input.access === "write") await assertStepUp(owner.id, session);
  const values = { access: input.access, tools: input.tools ?? null };
  await db
    .insert(mcpGrants)
    .values({ connectionId, agentId: agent.id, ...values })
    .onConflictDoUpdate({ target: [mcpGrants.connectionId, mcpGrants.agentId], set: values });
}

export async function deleteGrant(owner: Owner, connectionId: string, handle: string) {
  await ownedConnection(owner.id, connectionId);
  const agent = await getOwnedAgent(owner.id, handle);
  await db
    .delete(mcpGrants)
    .where(and(eq(mcpGrants.connectionId, connectionId), eq(mcpGrants.agentId, agent.id)));
}

export const shareInput = z.object({
  group: z.string().min(1).max(64),
  sharer: z.string().min(1).max(64),
  tools: z.array(z.string().min(1).max(128)).min(1).max(MAX_TOOLS),
  approval: z.enum(["none", "write", "all"]).default("write"),
  perAgentDaily: z.number().int().min(1).max(1000).default(50),
});

export async function createShare(
  owner: Owner,
  session: OwnerSession,
  connectionId: string,
  input: z.infer<typeof shareInput>,
): Promise<string> {
  const connection = await ownedConnection(owner.id, connectionId);
  const sharer = await getOwnedAgent(owner.id, input.sharer);
  const name = normalizeGroupName(input.group);
  const [group] = await db
    .select({ id: conversations.id, name: conversations.name })
    .from(conversations)
    .innerJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, conversations.id),
        eq(conversationMembers.agentId, sharer.id),
        eq(conversationMembers.status, "active"),
      ),
    )
    .where(and(eq(conversations.name, name), eq(conversations.kind, "group")));
  if (!group) {
    throw new AppError(
      "forbidden",
      `${formatHandle(sharer.handle)} isn't a member of ${formatGroupName(name)}.`,
    );
  }
  const [shares] = await db
    .select({ total: count() })
    .from(mcpShares)
    .where(eq(mcpShares.connectionId, connectionId));
  if ((shares?.total ?? 0) >= MAX_SHARES) {
    throw new AppError("conflict", `A connection can be shared with up to ${MAX_SHARES} groups.`);
  }
  const tools = await db
    .select()
    .from(mcpConnectionTools)
    .where(
      and(
        eq(mcpConnectionTools.connectionId, connectionId),
        inArray(mcpConnectionTools.name, input.tools),
      ),
    );
  if (tools.length !== new Set(input.tools).size) {
    throw new AppError("invalid_input", "Share tools this server has.");
  }
  if (tools.some((tool) => tool.write) || input.approval !== "all") {
    await assertStepUp(owner.id, session);
  }

  const id = uuidv7();
  const members = await db
    .select({ agent: agents, email: owners.email })
    .from(conversationMembers)
    .innerJoin(agents, eq(agents.id, conversationMembers.agentId))
    .innerJoin(owners, eq(owners.id, agents.ownerId))
    .where(
      and(
        eq(conversationMembers.conversationId, group.id),
        eq(conversationMembers.status, "active"),
      ),
    );
  const shared = [...new Set(input.tools)];
  const recorded = await db.transaction(async (tx) => {
    await tx.insert(mcpShares).values({
      id,
      connectionId,
      conversationId: group.id,
      sharerAgentId: sharer.id,
      tools: shared,
      approval: input.approval,
      perAgentDaily: input.perAgentDaily,
    });
    const events: RecordedEvent[] = [];
    const told = new Set([owner.email]);
    for (const { agent, email } of members) {
      if (agent.id === sharer.id) continue;
      if (!told.has(email)) {
        told.add(email);
        await enqueue(tx, "email.share", {
          email,
          sharer: formatHandle(sharer.handle),
          group: formatGroupName(name),
          connection: connection.name,
          tools: shared,
          url: new URL(`/dashboard/agents/${agent.handle}?tab=tools`, config.APP_URL).toString(),
        });
      }
      events.push(
        await createNotice(tx, agent, {
          kind: "tools.shared",
          actor: sharer,
          conversationId: group.id,
          planId: null,
          taskKey: null,
          text: `${formatHandle(sharer.handle)} shared ${connection.name} with ${formatGroupName(name)}: ${shared.join(", ")}. Calls run as its owner, who sees what you send. Your owner can turn shared tools off.`,
        }),
      );
    }
    return events;
  });
  await broadcast(recorded);
  return id;
}

export async function updateShare(
  owner: Owner,
  session: OwnerSession,
  connectionId: string,
  shareId: string,
  input: {
    tools?: string[] | undefined;
    approval?: ShareApproval | undefined;
    perAgentDaily?: number | undefined;
    paused?: boolean | undefined;
  },
): Promise<void> {
  await ownedConnection(owner.id, connectionId);
  const [share] = await db
    .select()
    .from(mcpShares)
    .where(and(eq(mcpShares.id, shareId), eq(mcpShares.connectionId, connectionId)));
  if (!share) throw new AppError("not_found", "No share with that id.");
  const loosens =
    (input.tools && input.tools.some((tool) => !share.tools.includes(tool))) ||
    (input.approval !== undefined &&
      input.approval !== "all" &&
      input.approval !== share.approval) ||
    (input.perAgentDaily !== undefined && input.perAgentDaily > share.perAgentDaily) ||
    (input.paused === false && share.paused);
  if (loosens) await assertStepUp(owner.id, session);
  await db
    .update(mcpShares)
    .set({
      ...(input.tools && { tools: [...new Set(input.tools)] }),
      ...(input.approval && { approval: input.approval }),
      ...(input.perAgentDaily && { perAgentDaily: input.perAgentDaily }),
      ...(input.paused !== undefined && { paused: input.paused }),
    })
    .where(eq(mcpShares.id, shareId));
}

export async function deleteShare(owner: Owner, connectionId: string, shareId: string) {
  await ownedConnection(owner.id, connectionId);
  await db
    .delete(mcpShares)
    .where(and(eq(mcpShares.id, shareId), eq(mcpShares.connectionId, connectionId)));
}

/** A member's owner opting one agent out of a share, or back in. Never needs a passkey to leave. */
export async function setShareOptOut(
  owner: Owner,
  session: OwnerSession,
  handle: string,
  shareId: string,
  enabled: boolean,
): Promise<void> {
  const agent = await getOwnedAgent(owner.id, handle);
  if (enabled) {
    await assertStepUp(owner.id, session);
    await db
      .delete(mcpShareOptOuts)
      .where(and(eq(mcpShareOptOuts.shareId, shareId), eq(mcpShareOptOuts.agentId, agent.id)));
  } else {
    await db.insert(mcpShareOptOuts).values({ shareId, agentId: agent.id }).onConflictDoNothing();
  }
}

export async function setSharedTools(
  owner: Owner,
  session: OwnerSession,
  handle: string,
  enabled: boolean,
): Promise<void> {
  const agent = await getOwnedAgent(owner.id, handle);
  if (enabled && !agent.sharedTools) await assertStepUp(owner.id, session);
  await db.update(agents).set({ sharedTools: enabled }).where(eq(agents.id, agent.id));
}

// ---- views -----------------------------------------------------------------------------------

export type ToolView = {
  name: string;
  title: string | null;
  description: string | null;
  write: boolean;
  enabled: boolean;
  status: McpConnectionTool["status"];
  exposed: boolean;
};

export type ConnectionSummary = {
  id: string;
  name: string;
  slug: string;
  serverUrl: string;
  host: string;
  authKind: McpConnection["authKind"];
  header: string | null;
  status: McpConnection["status"];
  lastError: string | null;
  toolsSyncedAt: string | null;
  tools: { total: number; enabled: number; changed: number };
  createdAt: string;
};

function summary(key: DataKey, row: McpConnection, tools: McpConnectionTool[]): ConnectionSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    serverUrl: row.serverUrl,
    host: new URL(row.serverUrl).host,
    authKind: row.authKind,
    header: readCredentials(key, row).header?.name ?? null,
    status: row.status,
    lastError: row.lastError,
    toolsSyncedAt: row.toolsSyncedAt?.toISOString() ?? null,
    tools: {
      total: tools.filter((tool) => tool.status !== "removed").length,
      enabled: tools.filter((tool) => tool.enabled && tool.status === "active").length,
      changed: tools.filter((tool) => tool.enabled && tool.status === "changed").length,
    },
    createdAt: row.createdAt.toISOString(),
  };
}

export function isExposable(tool: McpConnectionTool): boolean {
  return tool.enabled && tool.status === "active" && tool.approvedHash === tool.definitionHash;
}

export async function listConnections(owner: Owner): Promise<ConnectionSummary[]> {
  const rows = await db
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.ownerId, owner.id))
    .orderBy(mcpConnections.createdAt);
  if (rows.length === 0) return [];
  const tools = await db
    .select()
    .from(mcpConnectionTools)
    .where(
      inArray(
        mcpConnectionTools.connectionId,
        rows.map((row) => row.id),
      ),
    );
  const out: ConnectionSummary[] = [];
  for (const row of rows) {
    out.push(
      summary(
        await connectionKey(row),
        row,
        tools.filter((tool) => tool.connectionId === row.id),
      ),
    );
  }
  return out;
}

export async function connectionDetail(owner: Owner, id: string) {
  const row = await ownedConnection(owner.id, id);
  const key = await connectionKey(row);
  const [tools, grants, shares] = await Promise.all([
    db
      .select()
      .from(mcpConnectionTools)
      .where(eq(mcpConnectionTools.connectionId, id))
      .orderBy(mcpConnectionTools.name),
    db
      .select({ grant: mcpGrants, handle: agents.handle })
      .from(mcpGrants)
      .innerJoin(agents, eq(agents.id, mcpGrants.agentId))
      .where(eq(mcpGrants.connectionId, id)),
    db
      .select({ share: mcpShares, group: conversations.name, sharer: agents.handle })
      .from(mcpShares)
      .innerJoin(conversations, eq(conversations.id, mcpShares.conversationId))
      .innerJoin(agents, eq(agents.id, mcpShares.sharerAgentId))
      .where(eq(mcpShares.connectionId, id)),
  ]);
  const optOuts = shares.length
    ? await db
        .select({ shareId: mcpShareOptOuts.shareId, total: count() })
        .from(mcpShareOptOuts)
        .where(
          inArray(
            mcpShareOptOuts.shareId,
            shares.map(({ share }) => share.id),
          ),
        )
        .groupBy(mcpShareOptOuts.shareId)
    : [];
  return {
    connection: summary(key, row, tools),
    tools: tools.map((tool): ToolView => {
      const definition = openDefinition(key, tool);
      return {
        name: tool.name,
        title: definition.title ?? null,
        description: definition.description ?? null,
        write: tool.write,
        enabled: tool.enabled,
        status: tool.status,
        exposed: isExposable(tool),
      };
    }),
    grants: grants.map(({ grant, handle }) => ({
      agent: formatHandle(handle),
      access: grant.access,
      tools: grant.tools,
    })),
    shares: shares.map(({ share, group, sharer }) => ({
      id: share.id,
      group: formatGroupName(group ?? ""),
      sharer: formatHandle(sharer),
      tools: share.tools,
      approval: share.approval,
      perAgentDaily: share.perAgentDaily,
      paused: share.paused,
      optedOut: optOuts.find((row) => row.shareId === share.id)?.total ?? 0,
      createdAt: share.createdAt.toISOString(),
    })),
  };
}

export type ToolCallView = {
  id: string;
  connection: string;
  agent: string | null;
  tool: string;
  status: string;
  durationMs: number | null;
  error: string | null;
  arguments: unknown;
  shared: boolean;
  createdAt: string;
};

/** Calls through the owner's connections, and calls the owner's agents made through others'. */
export async function listToolCalls(
  owner: Owner,
  options: { connectionId?: string | undefined; limit: number },
): Promise<ToolCallView[]> {
  const rows = await db
    .select({
      call: mcpCalls,
      connection: mcpConnections,
      handle: agents.handle,
      agentOwner: agents.ownerId,
    })
    .from(mcpCalls)
    .innerJoin(mcpConnections, eq(mcpConnections.id, mcpCalls.connectionId))
    .leftJoin(agents, eq(agents.id, mcpCalls.agentId))
    .where(
      and(
        or(eq(mcpConnections.ownerId, owner.id), eq(agents.ownerId, owner.id)),
        options.connectionId ? eq(mcpCalls.connectionId, options.connectionId) : undefined,
      ),
    )
    .orderBy(desc(mcpCalls.createdAt))
    .limit(options.limit);
  const out: ToolCallView[] = [];
  for (const { call, connection, handle } of rows) {
    const mine = connection.ownerId === owner.id;
    const key = await connectionKey(connection);
    out.push({
      id: call.id,
      connection: connection.name,
      agent: handle ? formatHandle(handle) : null,
      tool: call.tool,
      status: call.status,
      durationMs: call.durationMs,
      error: call.error,
      arguments: call.args
        ? (JSON.parse(key.open(call.args, `mcp_calls.args:${call.id}`)) as unknown)
        : null,
      shared: !mine || call.shareId !== null,
      createdAt: call.createdAt.toISOString(),
    });
  }
  return out;
}

/** Shares that reach one of the owner's agents through its groups, with whether it opted out. */
export async function sharesForAgent(agent: Agent) {
  const rows = await db
    .select({
      share: mcpShares,
      connection: mcpConnections.name,
      connectionOwner: mcpConnections.ownerId,
      group: conversations.name,
      sharer: agents.handle,
      optedOut: mcpShareOptOuts.shareId,
    })
    .from(mcpShares)
    .innerJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, mcpShares.conversationId),
        eq(conversationMembers.agentId, agent.id),
        eq(conversationMembers.status, "active"),
      ),
    )
    .innerJoin(conversations, eq(conversations.id, mcpShares.conversationId))
    .innerJoin(mcpConnections, eq(mcpConnections.id, mcpShares.connectionId))
    .innerJoin(agents, eq(agents.id, mcpShares.sharerAgentId))
    .leftJoin(
      mcpShareOptOuts,
      and(eq(mcpShareOptOuts.shareId, mcpShares.id), eq(mcpShareOptOuts.agentId, agent.id)),
    );
  return rows
    .filter((row) => row.connectionOwner !== agent.ownerId)
    .map((row) => ({
      id: row.share.id,
      connection: row.connection,
      group: formatGroupName(row.group ?? ""),
      sharedBy: formatHandle(row.sharer),
      tools: row.share.tools,
      approval: row.share.approval,
      paused: row.share.paused,
      enabled: row.optedOut === null,
    }));
}
