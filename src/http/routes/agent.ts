import { Hono } from "hono";
import { z } from "zod";
import {
  agentRules,
  MAX_DESCRIPTION_LENGTH,
  publicProfile,
  updateAgent,
} from "../../domain/agents.ts";
import { findAgents, listContacts, saveContact } from "../../domain/contacts.ts";
import { AppError } from "../../domain/errors.ts";
import { MAX_ATTACHMENTS, readFile, uploadFile } from "../../domain/files.ts";
import {
  createGroup,
  inviteToGroup,
  leaveGroup,
  listGroups,
  MAX_GROUP_MEMBERS,
  removeFromGroup,
  respondToGroupInvite,
} from "../../domain/groups.ts";
import { listFollowUps, scheduleFollowUp } from "../../domain/follow-ups.ts";
import {
  createHandoff,
  latestHandoff,
  MAX_HANDOFF_FILE_LENGTH,
  MAX_HANDOFF_FILES,
  MAX_HANDOFF_TEXT,
} from "../../domain/handoffs.ts";
import { invitePerson } from "../../domain/invitations.ts";
import {
  addTasks,
  createPlan,
  getPlan,
  listPlans,
  MAX_DETAILS_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_TASKS,
  MAX_TITLE_LENGTH,
  TASK_STATUSES,
  updateTask,
} from "../../domain/plans.ts";
import {
  askOwner,
  MAX_OPTION_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTION_LENGTH,
  questionStatus,
} from "../../domain/questions.ts";
import { MAX_REPORT_DETAILS, REPORT_REASONS, reportAgent } from "../../domain/reports.ts";
import { serializeLedgerEvent } from "../../domain/ledger.ts";
import { waitForNotifications } from "../../domain/notifications.ts";
import {
  decideContact,
  getConversation,
  inboxSince,
  logAction,
  lookupAgent,
  MAX_BODY_LENGTH,
  MAX_WAIT_SECONDS,
  readInbox,
  sendMessage,
  UNTRUSTED_NOTICE,
  waitForInbox,
} from "../../domain/messaging.ts";
import { requireAgent } from "../auth.ts";
import { downloadResponse, pageQuery, parseBody, parseWith, type AppEnv } from "../context.ts";

const sendBody = z.object({
  to: z.string().min(1).max(64),
  body: z.string().min(1).max(MAX_BODY_LENGTH),
  idempotencyKey: z.string().min(1).max(200).optional(),
  attachments: z.array(z.uuid()).max(MAX_ATTACHMENTS).optional(),
});

export const reportBody = z.object({
  handle: z.string().min(1).max(64),
  reason: z.enum(REPORT_REASONS),
  details: z.string().max(MAX_REPORT_DETAILS).optional(),
});

const handles = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(MAX_GROUP_MEMBERS - 1);

const groupBody = z.object({
  name: z.string().min(3).max(33),
  members: handles,
  note: z.string().max(1000).optional(),
});

const fileBody = z
  .object({
    name: z.string().min(1).max(200),
    mimeType: z.string().max(100).optional(),
    text: z.string().optional(),
    base64: z.base64().optional(),
  })
  .refine((body) => (body.text === undefined) !== (body.base64 === undefined), {
    message: "Pass the content in either text or base64.",
  });

const group = (name: string) => `#${name}`;

const actionBody = z.object({
  summary: z.string().min(1).max(500),
  details: z.string().max(4000).optional(),
  relatedTo: z.string().max(64).optional(),
});

const inboxQuery = z.object({
  wait: z.coerce.number().int().min(0).max(MAX_WAIT_SECONDS).default(0),
  since: z.coerce.number().int().min(0).optional(),
});

const notificationsQuery = z.object({
  wait: z.coerce.number().int().min(0).max(MAX_WAIT_SECONDS).default(0),
  after: z.coerce.number().int().min(0).optional(),
});

const conversationQuery = pageQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.coerce.number().int().positive().optional(),
  after: z.coerce.number().int().min(0).optional(),
});

const profileBody = z.object({
  displayName: z.string().min(1).max(80).optional(),
  description: z.string().min(1).max(MAX_DESCRIPTION_LENGTH).optional(),
  webhookUrl: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .nullable()
    .optional(),
});

const taskBody = z.object({
  key: z.string().max(32).optional(),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  details: z.string().max(MAX_DETAILS_LENGTH).optional(),
  assignee: z.string().max(64).optional(),
  dependsOn: z.array(z.string().max(32)).max(MAX_TASKS).optional(),
  due: z.string().max(40).optional(),
});

const tasksBody = z.object({ tasks: z.array(taskBody).min(1).max(MAX_TASKS) });

const planBody = tasksBody.extend({
  with: z.string().min(1).max(64),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
});

export const taskChangeBody = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  note: z.string().max(MAX_NOTE_LENGTH).optional(),
  due: z.string().max(40).nullable().optional(),
  assignee: z.string().max(64).optional(),
});

const handoffBody = z.object({
  summary: z.string().min(1).max(MAX_HANDOFF_TEXT),
  next: z.string().max(MAX_HANDOFF_TEXT).optional(),
  files: z.array(z.string().min(1).max(MAX_HANDOFF_FILE_LENGTH)).max(MAX_HANDOFF_FILES).optional(),
  plan: z.uuid().optional(),
});

const followUpBody = z.object({
  in: z.string().max(20).optional(),
  at: z.string().max(40).optional(),
  note: z.string().min(1).max(1000),
  about: z.string().max(64).optional(),
});

const contactBody = z.object({
  handle: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  notes: z.string().max(500).optional(),
});

export const agentRoutes = new Hono<AppEnv>()
  .use("/v1/agent/*", requireAgent)
  .get("/v1/agent/me", async (c) => {
    const agent = c.get("agent");
    return c.json({ agent: publicProfile(agent), rules: await agentRules(agent) });
  })
  .patch("/v1/agent/me", async (c) => {
    const updated = await updateAgent(c.get("agent"), await parseBody(c, profileBody), "agent");
    return c.json({ agent: publicProfile(updated) });
  })
  .get("/v1/agent/lookup/:handle", async (c) =>
    c.json(await lookupAgent(c.get("agent"), c.req.param("handle"))),
  )
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
  .post("/v1/agent/plans", async (c) => {
    const { with: target, title, tasks } = await parseBody(c, planBody);
    const plan = await createPlan(c.get("agent"), { with: target, title, tasks });
    return c.json({ plan }, 201);
  })
  .get("/v1/agent/plans", async (c) => {
    const target = parseWith(z.string().max(64).optional(), c.req.query("with"));
    return c.json({ plans: await listPlans(c.get("agent"), { with: target }) });
  })
  .get("/v1/agent/plans/:id", async (c) =>
    c.json({ plan: await getPlan(c.get("agent"), parseWith(z.uuid(), c.req.param("id"))) }),
  )
  .post("/v1/agent/plans/:id/tasks", async (c) => {
    const { tasks } = await parseBody(c, tasksBody);
    const plan = await addTasks(c.get("agent"), parseWith(z.uuid(), c.req.param("id")), tasks);
    return c.json({ plan }, 201);
  })
  .patch("/v1/agent/plans/:id/tasks/:key", async (c) => {
    const change = await parseBody(c, taskChangeBody);
    const plan = await updateTask(
      c.get("agent"),
      parseWith(z.uuid(), c.req.param("id")),
      parseWith(z.string().min(1).max(32), c.req.param("key")),
      change,
    );
    return c.json({ plan });
  })
  .post("/v1/agent/handoffs", async (c) => {
    const input = await parseBody(c, handoffBody);
    const handoff = await createHandoff(c.get("agent"), input, c.get("client"));
    return c.json({ handoff }, 201);
  })
  .get("/v1/agent/handoffs/latest", async (c) =>
    c.json({ handoff: await latestHandoff(c.get("agent")) }),
  )
  .post("/v1/agent/follow-ups", async (c) => {
    const followUp = await scheduleFollowUp(c.get("agent"), await parseBody(c, followUpBody));
    return c.json({ followUp }, 201);
  })
  .get("/v1/agent/follow-ups", async (c) =>
    c.json({ followUps: await listFollowUps(c.get("agent")) }),
  )
  .get("/v1/agent/notifications", async (c) => {
    const { wait, after } = parseWith(notificationsQuery, c.req.query());
    return c.json(await waitForNotifications(c.get("agent"), after, wait, c.req.raw.signal));
  })
  .get("/v1/agent/inbox", async (c) => {
    const { wait, since } = parseWith(inboxQuery, c.req.query());
    const agent = c.get("agent");
    const tokenId = c.get("tokenId");
    const inbox = wait
      ? await waitForInbox(agent, wait, { signal: c.req.raw.signal, since, tokenId })
      : since === undefined
        ? await readInbox(agent, tokenId)
        : await inboxSince(agent, since);
    return c.json({ ...inbox, notice: UNTRUSTED_NOTICE });
  })
  .get("/v1/agent/conversations/:peer", async (c) => {
    const query = parseWith(conversationQuery, c.req.query());
    return c.json(
      await getConversation(c.get("agent"), c.req.param("peer"), {
        limit: query.limit,
        before: query.before,
        after: query.after,
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
  .post("/v1/agent/reports", async (c) => {
    const input = await parseBody(c, reportBody);
    return c.json(await reportAgent(c.get("agent"), input, "agent"), 201);
  })
  .get("/v1/agent/groups", async (c) => c.json({ groups: await listGroups(c.get("agent")) }))
  .post("/v1/agent/groups", async (c) => {
    const input = await parseBody(c, groupBody);
    return c.json(await createGroup(c.get("agent"), input), 201);
  })
  .post("/v1/agent/groups/:name/members", async (c) => {
    const { members, note } = await parseBody(
      c,
      z.object({ members: handles, note: z.string().max(1000).optional() }),
    );
    return c.json(
      await inviteToGroup(c.get("agent"), group(c.req.param("name")), { handles: members, note }),
    );
  })
  .delete("/v1/agent/groups/:name/members/:handle", async (c) => {
    await removeFromGroup(c.get("agent"), group(c.req.param("name")), c.req.param("handle"));
    return c.body(null, 204);
  })
  .post("/v1/agent/groups/:name/invitation", async (c) => {
    const { decision } = await parseBody(
      c,
      z.object({ decision: z.enum(["accept", "decline", "block"]) }),
    );
    return c.json(
      await respondToGroupInvite(c.get("agent"), group(c.req.param("name")), decision, "agent"),
    );
  })
  .post("/v1/agent/groups/:name/leave", async (c) => {
    await leaveGroup(c.get("agent"), group(c.req.param("name")), "agent");
    return c.body(null, 204);
  })
  .get("/v1/agent/groups/:name/messages", async (c) => {
    const query = parseWith(conversationQuery, c.req.query());
    return c.json(
      await getConversation(c.get("agent"), group(c.req.param("name")), {
        limit: query.limit,
        before: query.before,
        after: query.after,
        markRead: true,
      }),
    );
  })
  .post("/v1/agent/files", async (c) => {
    const agent = c.get("agent");
    if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File))
        throw new AppError("invalid_input", "Send the file in a field named file.");
      const content = Buffer.from(await file.arrayBuffer());
      return c.json(
        await uploadFile(agent, { name: file.name, mimeType: file.type, content }),
        201,
      );
    }
    const body = await parseBody(c, fileBody);
    const content =
      body.text !== undefined
        ? Buffer.from(body.text, "utf8")
        : Buffer.from(body.base64 ?? "", "base64");
    const mimeType = body.mimeType ?? (body.text !== undefined ? "text/plain" : undefined);
    return c.json(await uploadFile(agent, { name: body.name, mimeType, content }), 201);
  })
  .get("/v1/agent/files/:id", async (c) => {
    const { file, content } = await readFile(
      c.get("agent"),
      parseWith(z.uuid(), c.req.param("id")),
    );
    return downloadResponse(file, content);
  })
  .post("/v1/agent/questions", async (c) => {
    const input = await parseBody(
      c,
      z.object({
        question: z.string().min(1).max(MAX_QUESTION_LENGTH),
        context: z.string().max(4000).optional(),
        options: z.array(z.string().min(1).max(MAX_OPTION_LENGTH)).max(MAX_OPTIONS).optional(),
      }),
    );
    return c.json(await askOwner(c.get("agent"), input), 201);
  })
  .get("/v1/agent/questions/:id", async (c) =>
    c.json(await questionStatus(c.get("agent"), parseWith(z.uuid(), c.req.param("id")))),
  )
  .post("/v1/agent/invitations", async (c) => {
    const input = await parseBody(
      c,
      z.object({ email: z.string().min(3).max(254), note: z.string().max(1000).optional() }),
    );
    return c.json(await invitePerson(c.get("agent"), input), 201);
  })
  .post("/v1/agent/actions", async (c) => {
    const agent = c.get("agent");
    const event = await logAction(agent, await parseBody(c, actionBody), "agent");
    return c.json(serializeLedgerEvent(event, agent.handle), 201);
  });
