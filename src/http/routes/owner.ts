import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  createAgent,
  createAgentToken,
  getOwnedAgent,
  listAgentTokens,
  listOwnerAgents,
  mcpUrl,
  ownerView,
  PRODUCTS,
  revokeAgentToken,
  tokenView,
  updateAgent,
} from "../../domain/agents.ts";
import {
  listLedger,
  listOwnerActivity,
  serializeLedgerEvent,
  verifyLedger,
} from "../../domain/ledger.ts";
import { decideContact, getConversation, listConversations } from "../../domain/messaging.ts";
import { subscribeToOwner } from "../../lib/events.ts";
import { requireOwner } from "../auth.ts";
import { pageQuery, parseBody, parseWith, type AppEnv } from "../context.ts";

const createAgentBody = z.object({
  handle: z.string().min(1).max(64),
  displayName: z.string().max(80).optional(),
  product: z.enum(PRODUCTS),
});

const updateAgentBody = z.object({
  displayName: z.string().min(1).max(80).optional(),
  webhookUrl: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .nullable()
    .optional(),
  notifyEmail: z.email().max(254).nullable().optional(),
});

const ledgerQuery = pageQuery.extend({ before: z.coerce.number().int().positive().optional() });
const activityQuery = pageQuery.extend({ before: z.iso.datetime().optional() });

export const ownerRoutes = new Hono<AppEnv>()
  .use("/v1/me", requireOwner)
  .use("/v1/agents", requireOwner)
  .use("/v1/agents/*", requireOwner)
  .use("/v1/activity", requireOwner)
  .use("/v1/events", requireOwner)
  .get("/v1/me", (c) => {
    const owner = c.get("owner");
    return c.json({ owner: { id: owner.id, email: owner.email } });
  })
  .get("/v1/agents", async (c) => {
    const agents = await listOwnerAgents(c.get("owner").id);
    return c.json({ agents: agents.map(ownerView) });
  })
  .post("/v1/agents", async (c) => {
    const input = await parseBody(c, createAgentBody);
    const agent = await createAgent(c.get("owner"), input);
    return c.json({ agent: ownerView(agent), mcpUrl: mcpUrl() }, 201);
  })
  .get("/v1/agents/:handle", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    return c.json({ agent: ownerView(agent), mcpUrl: mcpUrl() });
  })
  .patch("/v1/agents/:handle", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    const updated = await updateAgent(agent, await parseBody(c, updateAgentBody));
    return c.json({ agent: ownerView(updated) });
  })
  .get("/v1/agents/:handle/tokens", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    const tokens = await listAgentTokens(agent.id);
    return c.json({ tokens: tokens.map(tokenView) });
  })
  .post("/v1/agents/:handle/tokens", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    const { name } = await parseBody(c, z.object({ name: z.string().max(80).default("Default") }));
    const { token, record } = await createAgentToken(agent, name);
    return c.json({ token, info: tokenView(record) }, 201);
  })
  .delete("/v1/agents/:handle/tokens/:tokenId", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    await revokeAgentToken(agent, parseWith(z.uuid(), c.req.param("tokenId")));
    return c.body(null, 204);
  })
  .get("/v1/agents/:handle/conversations", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    return c.json({ conversations: await listConversations(agent) });
  })
  .get("/v1/agents/:handle/conversations/:peer", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    const query = parseWith(ledgerQuery, c.req.query());
    const conversation = await getConversation(agent, c.req.param("peer"), {
      limit: query.limit,
      before: query.before,
      markRead: false,
    });
    return c.json(conversation);
  })
  .post("/v1/agents/:handle/contacts/:peer", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    const { action } = await parseBody(
      c,
      z.object({ action: z.enum(["accept", "decline", "block", "unblock"]) }),
    );
    return c.json(await decideContact(agent, c.req.param("peer"), action, "owner"));
  })
  .get("/v1/agents/:handle/ledger", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    const query = parseWith(ledgerQuery, c.req.query());
    const events = await listLedger(agent.id, query);
    return c.json({ events: events.map((e) => serializeLedgerEvent(e, agent.handle)) });
  })
  .get("/v1/agents/:handle/ledger/verify", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    return c.json(await verifyLedger(agent.id));
  })
  .get("/v1/activity", async (c) => {
    const query = parseWith(activityQuery, c.req.query());
    const rows = await listOwnerActivity(c.get("owner").id, {
      limit: query.limit,
      before: query.before ? new Date(query.before) : undefined,
    });
    return c.json({ events: rows.map(({ event, handle }) => serializeLedgerEvent(event, handle)) });
  })
  .get("/v1/events", (c) => {
    const ownerId = c.get("owner").id;
    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribeToOwner(ownerId, (event) => {
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      });
      stream.onAbort(unsubscribe);
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(25_000);
      }
      unsubscribe();
    });
  });
