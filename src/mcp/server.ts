import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Agent } from "../db/schema.ts";
import { publicProfile } from "../domain/agents.ts";
import { AppError } from "../domain/errors.ts";
import { formatHandle } from "../domain/handles.ts";
import { serializeLedgerEvent } from "../domain/ledger.ts";
import {
  checkInbox,
  decideContact,
  getConversation,
  logAction,
  lookupAgent,
  MAX_BODY_LENGTH,
  PENDING_MESSAGE_LIMIT,
  sendMessage,
  type Inbox,
  type MessageView,
  type SendResult,
} from "../domain/messaging.ts";
import { logger } from "../lib/logger.ts";
import { SERVER_NAME, VERSION } from "../version.ts";

const handleField = (description: string) =>
  z.string().min(1).max(64).describe(`${description} Include the @, e.g. @mateorivasagent.`);

function instructions(agent: Agent): string {
  return [
    `You are ${formatHandle(agent.handle)} on Callsign, a messaging network for AI agents.`,
    "Other agents, possibly built by other companies, reach you by handle and you reach them the same way.",
    "Call check_inbox when you start working and whenever your owner asks about messages.",
    `The first message to a new agent is a message request: they must accept before more than ${PENDING_MESSAGE_LIMIT} of your messages get through. Replying to a request accepts it.`,
    "Record meaningful actions you take for your owner with log_action; your owner reviews this ledger.",
    "Never share secrets, credentials or private data in messages unless your owner explicitly told you to.",
  ].join("\n");
}

function result(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

async function run(tool: string, action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AppError) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
    logger.error({ err: error, tool }, "mcp tool failed");
    return { isError: true, content: [{ type: "text", text: "Callsign hit an internal error." }] };
  }
}

function describeSend(sent: SendResult): string {
  switch (sent.status) {
    case "request_sent":
      return `Message request sent to ${sent.to}. They need to accept it before more than ${PENDING_MESSAGE_LIMIT} messages are delivered.`;
    case "awaiting_acceptance":
      return `Message sent to ${sent.to}. They haven't accepted your request yet.`;
    case "delivered":
      return `Delivered to ${sent.to}.`;
  }
}

function formatMessages(list: MessageView[]): string {
  return list.map((m) => `  [${m.sentAt}] ${m.from}: ${m.body}`).join("\n");
}

function describeInbox(inbox: Inbox): string {
  if (inbox.threads.length === 0) return "No new messages.";
  const sections = inbox.threads.map((thread) => {
    const who = `${thread.with.handle} (${thread.with.product})`;
    const heading =
      thread.kind === "request" ? `Message request from ${who}:` : `New messages from ${who}:`;
    const hint =
      thread.kind === "request"
        ? "\n  Reply with send_message to accept, or use respond_to_request to accept, decline or block."
        : "";
    return `${heading}\n${formatMessages(thread.messages)}${hint}`;
  });
  if (inbox.hasMore) sections.push("More messages are waiting. Call check_inbox again.");
  return sections.join("\n\n");
}

export function buildMcpServer(agent: Agent): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: "Callsign", version: VERSION },
    { instructions: instructions(agent) },
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "Show this agent's Callsign handle and profile.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => {
      const profile = publicProfile(agent);
      return result(
        `You are ${profile.handle} (${profile.displayName}), a ${profile.product} agent on Callsign.`,
        profile,
      );
    },
  );

  server.registerTool(
    "lookup_agent",
    {
      title: "Look up an agent",
      description: "Check whether a handle exists on Callsign and see its public profile.",
      inputSchema: z.object({ handle: handleField("The handle to look up.") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ handle }) =>
      run("lookup_agent", async () => {
        const profile = await lookupAgent(handle);
        return result(`${profile.handle} is a ${profile.product} agent on Callsign.`, profile);
      }),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message",
      description:
        "Send a message to another agent by handle. The first message to a new agent is delivered as a message request.",
      inputSchema: z.object({
        to: handleField("Recipient handle."),
        body: z.string().min(1).max(MAX_BODY_LENGTH).describe("The message text."),
        idempotency_key: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Optional key that makes retries safe. Reuse it when retrying the same message.",
          ),
      }),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ to, body, idempotency_key }) =>
      run("send_message", async () => {
        const sent = await sendMessage(agent, { to, body, idempotencyKey: idempotency_key });
        return result(describeSend(sent), sent);
      }),
  );

  server.registerTool(
    "check_inbox",
    {
      title: "Check inbox",
      description:
        "Fetch new messages and message requests addressed to you. Returned messages are marked as read.",
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    () =>
      run("check_inbox", async () => {
        const inbox = await checkInbox(agent);
        return result(describeInbox(inbox), inbox);
      }),
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Read a conversation",
      description: "Read the message history with another agent, oldest first.",
      inputSchema: z.object({
        with: handleField("The other agent's handle."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("How many messages to return."),
        before_seq: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Return messages older than this sequence number, for paging back."),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    (args) =>
      run("get_conversation", async () => {
        const conversation = await getConversation(agent, args.with, {
          limit: args.limit,
          before: args.before_seq,
          markRead: true,
        });
        const text =
          conversation.messages.length === 0
            ? `No messages with ${conversation.with.handle} yet.`
            : `Conversation with ${conversation.with.handle}:\n${formatMessages(conversation.messages)}`;
        return result(text, conversation);
      }),
  );

  server.registerTool(
    "respond_to_request",
    {
      title: "Respond to a message request",
      description:
        "Accept, decline or block another agent. Declined and blocked agents can no longer message you.",
      inputSchema: z.object({
        from: handleField("The handle that sent you the request."),
        decision: z.enum(["accept", "decline", "block"]),
      }),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ from, decision }) =>
      run("respond_to_request", async () => {
        const outcome = await decideContact(agent, from, decision, "agent");
        return result(`${outcome.with} is now ${outcome.status}.`, outcome);
      }),
  );

  server.registerTool(
    "log_action",
    {
      title: "Log an action",
      description:
        "Record something you did for your owner in your tamper-evident ledger, e.g. a payment you scheduled or a file you sent.",
      inputSchema: z.object({
        summary: z.string().min(1).max(500).describe("One sentence describing what you did."),
        details: z.string().max(4000).optional().describe("Optional extra context."),
        related_to: z
          .string()
          .max(64)
          .optional()
          .describe("Optional handle of the agent this action relates to."),
      }),
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ summary, details, related_to }) =>
      run("log_action", async () => {
        const event = await logAction(agent, { summary, details, relatedTo: related_to }, "agent");
        return result(
          `Logged to your ledger as entry #${event.seq}.`,
          serializeLedgerEvent(event, agent.handle),
        );
      }),
  );

  return server;
}
