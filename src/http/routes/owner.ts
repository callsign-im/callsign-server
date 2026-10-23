import { Hono } from "hono";
import { config } from "../../config.ts";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { deleteAccount, deleteAgent, exportAccount } from "../../domain/account.ts";
import {
  agentRules,
  createAgent,
  createAgentToken,
  getOwnedAgent,
  listAgentTokens,
  listOwnerAgents,
  MAX_DESCRIPTION_LENGTH,
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
import { deleteContact, listContacts, saveContact, updateContact } from "../../domain/contacts.ts";
import { readFile } from "../../domain/files.ts";
import { leaveGroup } from "../../domain/groups.ts";
import { organizationDomain } from "../../domain/identity.ts";
import { connectInvitations } from "../../domain/invitations.ts";
import { answerQuestion, listOwnerQuestions } from "../../domain/questions.ts";
import { decideContact, getConversation, listConversations } from "../../domain/messaging.ts";
import { ownerAccountView, updateOwner } from "../../domain/owners.ts";
import { subscribeToOwner } from "../../lib/events.ts";
import { checkInPrompt, customInstructions, memoryNote } from "../../mcp/guide.ts";
import { clearSessionCookie, requireOwner } from "../auth.ts";
import { downloadResponse, pageQuery, parseBody, parseWith, type AppEnv } from "../context.ts";

const descriptionField = z.string().max(MAX_DESCRIPTION_LENGTH);

const createAgentBody = z.object({
  handle: z.string().min(1).max(64),
  displayName: z.string().max(80).optional(),
  description: descriptionField.optional(),
  product: z.enum(PRODUCTS),
  rules: z.string().max(2000).nullable().optional(),
});

const updateAgentBody = z.object({
  displayName: z.string().min(1).max(80).optional(),
  description: descriptionField.nullable().optional(),
  primary: z.literal(true).optional(),
  webhookUrl: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .nullable()
    .optional(),
  notifyEmail: z.email().max(254).nullable().optional(),
  discoverable: z.boolean().optional(),
  rules: z.string().max(2000).nullable().optional(),
});

const ownerContactBody = z.object({
  handle: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  notes: z.string().max(500).nullable().optional(),
  rules: z.string().max(2000).nullable().optional(),
});

const ledgerQuery = pageQuery.extend({ before: z.coerce.number().int().positive().optional() });
const activityQuery = pageQuery.extend({ before: z.iso.datetime().optional() });

export const ownerRoutes = new Hono<AppEnv>()
  .use("/v1/me", requireOwner)
  .use("/v1/me/*", requireOwner)
  .use("/v1/agents", requireOwner)
  .use("/v1/agents/*", requireOwner)
  .use("/v1/activity", requireOwner)
  .use("/v1/events", requireOwner)
  .use("/v1/contacts", requireOwner)
  .use("/v1/contacts/*", requireOwner)
  .use("/v1/questions", requireOwner)
  .use("/v1/questions/*", requireOwner)
  .get("/v1/questions", async (c) => {
    const { status } = parseWith(
      z.object({ status: z.enum(["open", "answered"]).default("open") }),
      c.req.query(),
    );
    return c.json({
      questions: await listOwnerQuestions(c.get("owner").id, { open: status === "open" }),
    });
  })
  .post("/v1/questions/:id", async (c) => {
    const { answer } = await parseBody(c, z.object({ answer: z.string().min(1).max(4000) }));
    return c.json(
      await answerQuestion(c.get("owner").id, parseWith(z.uuid(), c.req.param("id")), answer),
    );
  })
  .get("/v1/contacts", async (c) => c.json({ contacts: await listContacts(c.get("owner").id) }))
  .post("/v1/contacts", async (c) => {
    const input = await parseBody(c, ownerContactBody);
    return c.json(await saveContact(c.get("owner").id, input), 201);
  })
  .patch("/v1/contacts/:id", async (c) => {
    const id = parseWith(z.uuid(), c.req.param("id"));
    const fields = await parseBody(c, ownerContactBody.omit({ handle: true }).partial());
    return c.json(await updateContact(c.get("owner").id, id, fields));
  })
  .delete("/v1/contacts/:id", async (c) => {
    await deleteContact(c.get("owner").id, parseWith(z.uuid(), c.req.param("id")));
    return c.body(null, 204);
  })
  .get("/v1/agents/:handle/instructions", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    return c.json({
      instructions: customInstructions(agent, await agentRules(agent), mcpUrl()),
      memoryNote: memoryNote(agent.handle),
      checkInPrompt: checkInPrompt(agent.handle),
      skillUrl: new URL("/skill.md", config.PUBLIC_API_URL).toString(),
    });
  })
  .get("/v1/me", (c) => {
    const owner = c.get("owner");
    return c.json({
      owner: { ...ownerAccountView(owner), organizationDomain: organizationDomain(owner.email) },
    });
  })
  .patch("/v1/me", async (c) => {
    const fields = await parseBody(c, z.object({ showDomain: z.boolean().optional() }));
    const owner = await updateOwner(c.get("owner"), fields);
    return c.json({
      owner: { ...ownerAccountView(owner), organizationDomain: organizationDomain(owner.email) },
    });
  })
  .delete("/v1/me", async (c) => {
    await deleteAccount(c.get("owner"));
    clearSessionCookie(c);
    return c.body(null, 204);
  })
  .get("/v1/me/export", async (c) => {
    const date = new Date().toISOString().slice(0, 10);
    return c.json(await exportAccount(c.get("owner")), 200, {
      "content-disposition": `attachment; filename="callsign-export-${date}.json"`,
    });
  })
  .get("/v1/agents", async (c) => {
    const agents = await listOwnerAgents(c.get("owner").id);
    return c.json({ agents: await Promise.all(agents.map(ownerView)) });
  })
  .post("/v1/agents", async (c) => {
    const input = await parseBody(c, createAgentBody);
    const agent = await createAgent(c.get("owner"), input);
    await connectInvitations(agent);
    return c.json({ agent: await ownerView(agent), mcpUrl: mcpUrl() }, 201);
  })
  .get("/v1/agents/:handle", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    return c.json({ agent: await ownerView(agent), mcpUrl: mcpUrl() });
  })
  .patch("/v1/agents/:handle", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    const updated = await updateAgent(agent, await parseBody(c, updateAgentBody));
    return c.json({ agent: await ownerView(updated) });
  })
  .delete("/v1/agents/:handle", async (c) => {
    await deleteAgent(await getOwnedAgent(c.get("owner").id, c.req.param("handle")));
    return c.body(null, 204);
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
  .get("/v1/agents/:handle/files/:id", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    const { file, content } = await readFile(agent, parseWith(z.uuid(), c.req.param("id")));
    return downloadResponse(file, content);
  })
  .post("/v1/agents/:handle/groups/:name/leave", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    await leaveGroup(agent, `#${c.req.param("name")}`, "owner");
    return c.body(null, 204);
  })
  .get("/v1/agents/:handle/ledger", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    const query = parseWith(ledgerQuery, c.req.query());
    const events = await listLedger(agent, query);
    return c.json({ events: events.map((e) => serializeLedgerEvent(e, agent.handle)) });
  })
  .get("/v1/agents/:handle/ledger/verify", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    return c.json(await verifyLedger(agent));
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
