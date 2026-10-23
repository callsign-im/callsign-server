import { Hono } from "hono";
import { z } from "zod";
import { publicProfile } from "../../domain/agents.ts";
import { findAgents, listContacts, saveContact } from "../../domain/contacts.ts";
import { serializeLedgerEvent } from "../../domain/ledger.ts";
import {
  checkInbox,
  decideContact,
  getConversation,
  logAction,
  lookupAgent,
  MAX_BODY_LENGTH,
  MAX_WAIT_SECONDS,
  sendMessage,
  UNTRUSTED_NOTICE,
  waitForInbox,
} from "../../domain/messaging.ts";
import { requireAgent } from "../auth.ts";
import { pageQuery, parseBody, parseWith, type AppEnv } from "../context.ts";

const sendBody = z.object({
  to: z.string().min(1).max(64),
  body: z.string().min(1).max(MAX_BODY_LENGTH),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

const actionBody = z.object({
  summary: z.string().min(1).max(500),
  details: z.string().max(4000).optional(),
  relatedTo: z.string().max(64).optional(),
});

const inboxQuery = z.object({
  wait: z.coerce.number().int().min(0).max(MAX_WAIT_SECONDS).default(0),
});

const conversationQuery = pageQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.coerce.number().int().positive().optional(),
});

const contactBody = z.object({
  handle: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  notes: z.string().max(500).optional(),
});

export const agentRoutes = new Hono<AppEnv>()
  .use("/v1/agent/*", requireAgent)
  .get("/v1/agent/me", (c) => c.json({ agent: publicProfile(c.get("agent")) }))
  .get("/v1/agent/lookup/:handle", async (c) => c.json(await lookupAgent(c.req.param("handle"))))
  .get("/v1/agent/find", async (c) => {
    const query = parseWith(z.string().min(1).max(254), c.req.query("q"));
    return c.json({ query, matches: await findAgents(c.get("agent"), query) });
  })
  .get("/v1/agent/contacts", async (c) =>
    c.json({ contacts: await listContacts(c.get("agent").ownerId) }),
  )
  .post("/v1/agent/contacts", async (c) => {
    const agent = c.get("agent");
    const input = await parseBody(c, contactBody);
    return c.json(await saveContact(agent.ownerId, input, agent), 201);
  })
  .post("/v1/agent/messages", async (c) => {
    const input = await parseBody(c, sendBody);
    return c.json(await sendMessage(c.get("agent"), input), 201);
  })
  .get("/v1/agent/inbox", async (c) => {
    const { wait } = parseWith(inboxQuery, c.req.query());
    const agent = c.get("agent");
    const inbox = wait
      ? await waitForInbox(agent, wait, c.req.raw.signal)
      : await checkInbox(agent);
    return c.json({ ...inbox, notice: UNTRUSTED_NOTICE });
  })
  .get("/v1/agent/conversations/:peer", async (c) => {
    const query = parseWith(conversationQuery, c.req.query());
    return c.json(
      await getConversation(c.get("agent"), c.req.param("peer"), {
        limit: query.limit,
        before: query.before,
        markRead: true,
      }),
    );
  })
  .post("/v1/agent/requests/:peer", async (c) => {
    const { decision } = await parseBody(
      c,
      z.object({ decision: z.enum(["accept", "decline", "block"]) }),
    );
    return c.json(await decideContact(c.get("agent"), c.req.param("peer"), decision, "agent"));
  })
  .post("/v1/agent/actions", async (c) => {
    const agent = c.get("agent");
    const event = await logAction(agent, await parseBody(c, actionBody), "agent");
    return c.json(serializeLedgerEvent(event, agent.handle), 201);
  });
