import { Hono } from "hono";
import { z } from "zod";
import { config } from "../../config.ts";
import { getOwnedAgent } from "../../domain/agents.ts";
import {
  CALLBACK_PATH,
  clientMetadata,
  finishConnectionAuth,
} from "../../domain/connection-auth.ts";
import {
  connectionDetail,
  connectionInput,
  createConnection,
  createShare,
  deleteConnection,
  deleteGrant,
  deleteShare,
  listConnections,
  listToolCalls,
  putGrant,
  reconnect,
  setSharedTools,
  setShareOptOut,
  shareInput,
  sharesForAgent,
  syncConnection,
  updateConnection,
  updateShare,
  updateTool,
} from "../../domain/connections.ts";
import { AppError } from "../../domain/errors.ts";
import { exposedTools, exposedView } from "../../domain/tool-access.ts";
import { logger } from "../../lib/logger.ts";
import { requireOwner } from "../auth.ts";
import { parseBody, parseWith, type AppEnv } from "../context.ts";

const id = z.uuid();
const enabledBody = z.object({ enabled: z.boolean() });

function dashboard(path: string, params: Record<string, string> = {}) {
  const url = new URL(path, config.APP_URL);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

export const connectionRoutes = new Hono<AppEnv>()
  // Callsign's OAuth client ID metadata document, for servers that accept URL client IDs.
  .get("/oauth/client.json", (c) =>
    c.json(clientMetadata(), 200, { "cache-control": "public, max-age=3600" }),
  )
  // The owner's browser lands here after signing in on the other server.
  .get(CALLBACK_PATH, async (c) => {
    const { code, state, iss, error } = c.req.query();
    if (error || !code || !state) {
      return c.redirect(dashboard("/dashboard/connections", { error: error ?? "cancelled" }));
    }
    try {
      const connection = await finishConnectionAuth({ code, state, iss });
      await syncConnection({ connectionId: connection.id });
      return c.redirect(dashboard(`/dashboard/connections/${connection.id}`, { connected: "1" }));
    } catch (err) {
      logger.info({ err }, "connection sign-in failed");
      const message = err instanceof AppError ? err.message : "The sign-in didn't finish.";
      return c.redirect(dashboard("/dashboard/connections", { error: message }));
    }
  })
  .use("/v1/connections", requireOwner)
  .use("/v1/connections/*", requireOwner)
  .use("/v1/tool-calls", requireOwner)
  .use("/v1/agents/*", requireOwner)
  .get("/v1/connections", async (c) =>
    c.json({ connections: await listConnections(c.get("owner")) }),
  )
  .post("/v1/connections", async (c) => {
    const input = await parseBody(c, connectionInput);
    const { connection, authorizationUrl } = await createConnection(c.get("owner"), input);
    return c.json({ id: connection.id, status: connection.status, authorizationUrl }, 201);
  })
  .get("/v1/connections/:id", async (c) =>
    c.json(await connectionDetail(c.get("owner"), parseWith(id, c.req.param("id")))),
  )
  .patch("/v1/connections/:id", async (c) => {
    const input = await parseBody(
      c,
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        header: z
          .object({ name: z.string().min(1).max(64), value: z.string().min(1).max(4096) })
          .optional(),
      }),
    );
    const connectionId = parseWith(id, c.req.param("id"));
    await updateConnection(c.get("owner"), c.get("session"), connectionId, input);
    return c.json(await connectionDetail(c.get("owner"), connectionId));
  })
  .delete("/v1/connections/:id", async (c) => {
    await deleteConnection(c.get("owner"), parseWith(id, c.req.param("id")));
    return c.body(null, 204);
  })
  .post("/v1/connections/:id/authorize", async (c) => {
    const authorizationUrl = await reconnect(c.get("owner"), parseWith(id, c.req.param("id")));
    return c.json({ authorizationUrl });
  })
  .post("/v1/connections/:id/sync", async (c) => {
    const owner = c.get("owner");
    const connectionId = parseWith(id, c.req.param("id"));
    await connectionDetail(owner, connectionId);
    await syncConnection({ connectionId });
    return c.json(await connectionDetail(owner, connectionId));
  })
  .patch("/v1/connections/:id/tools/:name", async (c) => {
    const input = await parseBody(
      c,
      z.object({ enabled: z.boolean().optional(), write: z.boolean().optional() }),
    );
    const connectionId = parseWith(id, c.req.param("id"));
    await updateTool(c.get("owner"), c.get("session"), connectionId, c.req.param("name"), input);
    return c.json(await connectionDetail(c.get("owner"), connectionId));
  })
  .put("/v1/connections/:id/grants/:handle", async (c) => {
    const input = await parseBody(
      c,
      z.object({
        access: z.enum(["read", "write"]),
        tools: z.array(z.string().min(1).max(128)).max(200).nullable().optional(),
      }),
    );
    const connectionId = parseWith(id, c.req.param("id"));
    await putGrant(c.get("owner"), c.get("session"), connectionId, c.req.param("handle"), input);
    return c.json(await connectionDetail(c.get("owner"), connectionId));
  })
  .delete("/v1/connections/:id/grants/:handle", async (c) => {
    const connectionId = parseWith(id, c.req.param("id"));
    await deleteGrant(c.get("owner"), connectionId, c.req.param("handle"));
    return c.json(await connectionDetail(c.get("owner"), connectionId));
  })
  .post("/v1/connections/:id/shares", async (c) => {
    const input = await parseBody(c, shareInput);
    const connectionId = parseWith(id, c.req.param("id"));
    await createShare(c.get("owner"), c.get("session"), connectionId, input);
    return c.json(await connectionDetail(c.get("owner"), connectionId), 201);
  })
  .patch("/v1/connections/:id/shares/:shareId", async (c) => {
    const input = await parseBody(
      c,
      z.object({
        tools: z.array(z.string().min(1).max(128)).min(1).max(200).optional(),
        approval: z.enum(["none", "write", "all"]).optional(),
        perAgentDaily: z.number().int().min(1).max(1000).optional(),
        paused: z.boolean().optional(),
      }),
    );
    const connectionId = parseWith(id, c.req.param("id"));
    const shareId = parseWith(id, c.req.param("shareId"));
    await updateShare(c.get("owner"), c.get("session"), connectionId, shareId, input);
    return c.json(await connectionDetail(c.get("owner"), connectionId));
  })
  .delete("/v1/connections/:id/shares/:shareId", async (c) => {
    const connectionId = parseWith(id, c.req.param("id"));
    await deleteShare(c.get("owner"), connectionId, parseWith(id, c.req.param("shareId")));
    return c.json(await connectionDetail(c.get("owner"), connectionId));
  })
  .get("/v1/tool-calls", async (c) => {
    const { connection, limit } = parseWith(
      z.object({
        connection: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      c.req.query(),
    );
    return c.json({
      calls: await listToolCalls(c.get("owner"), { connectionId: connection, limit }),
    });
  })
  .get("/v1/agents/:handle/tools", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    const [tools, shares] = await Promise.all([exposedTools(agent), sharesForAgent(agent)]);
    return c.json({
      sharedTools: agent.sharedTools,
      tools: tools.map(exposedView),
      shares,
    });
  })
  .put("/v1/agents/:handle/shared-tools", async (c) => {
    const { enabled } = await parseBody(c, enabledBody);
    await setSharedTools(c.get("owner"), c.get("session"), c.req.param("handle"), enabled);
    return c.body(null, 204);
  })
  .put("/v1/agents/:handle/shared-tools/:shareId", async (c) => {
    const { enabled } = await parseBody(c, enabledBody);
    await setShareOptOut(
      c.get("owner"),
      c.get("session"),
      c.req.param("handle"),
      parseWith(id, c.req.param("shareId")),
      enabled,
    );
    return c.body(null, 204);
  });
