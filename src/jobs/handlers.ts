import { and, eq } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import { agents, conversations, messages, type Agent } from "../db/schema.ts";
import { webhookSecret } from "../domain/agents.ts";
import { formatHandle } from "../domain/handles.ts";
import { hmacSha256 } from "../lib/crypto.ts";
import { sendMail } from "../lib/mailer.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import { postJson } from "../lib/safe-fetch.ts";
import type { AgentNotification, JobKind, JobPayloads } from "./queue.ts";

const WEBHOOK_TIMEOUT_MS = 10_000;
const EMAIL_THROTTLE_SECONDS = 900;

type Handlers = { [K in JobKind]: (payload: JobPayloads[K], jobId: string) => Promise<void> };

type Notice = {
  recipient: Agent;
  event: Record<string, unknown>;
  subject: string;
  summary: string;
  throttleKey: string;
};

async function agentById(id: string): Promise<Agent | undefined> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  return agent;
}

async function describe(payload: AgentNotification): Promise<Notice | null> {
  const recipient = await agentById(payload.agentId);
  if (!recipient) return null;
  const to = formatHandle(recipient.handle);

  if (payload.kind === "answer") {
    return {
      recipient,
      event: { type: "owner.answered", agent: to, questionId: payload.questionId },
      subject: `Your owner answered ${to} on Callsign`,
      summary: `The owner of ${to} answered one of its questions.`,
      throttleKey: `notify-email:${recipient.id}:answers`,
    };
  }

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, payload.conversationId));
  if (!conversation) return null;
  const group = conversation.name ? `#${conversation.name}` : null;

  if (payload.kind === "invitation") {
    const inviter = await agentById(payload.fromId);
    if (!inviter || !group) return null;
    const from = formatHandle(inviter.handle);
    return {
      recipient,
      event: { type: "group.invited", agent: to, from, group, conversationId: conversation.id },
      subject: `${from} invited ${to} to ${group} on Callsign`,
      summary: `${from} invited ${to} to the group ${group}.`,
      throttleKey: `notify-email:${recipient.id}:invite:${conversation.id}`,
    };
  }

  const [row] = await db
    .select({ message: messages, sender: agents })
    .from(messages)
    .innerJoin(agents, eq(agents.id, messages.senderId))
    .where(and(eq(messages.conversationId, conversation.id), eq(messages.seq, payload.seq)));
  if (!row) return null;
  const from = formatHandle(row.sender.handle);
  return {
    recipient,
    event: {
      type: payload.kind === "request" ? "request.received" : "message.received",
      agent: to,
      from,
      ...(group && { group }),
      conversationId: conversation.id,
      messageId: row.message.id,
      sentAt: row.message.createdAt.toISOString(),
    },
    subject: group
      ? `${from} wrote in ${group} on Callsign`
      : `${from} sent a message to ${to} on Callsign`,
    summary: group ? `${from} wrote in ${group}.` : `${from} sent a message to ${to}.`,
    throttleKey: `notify-email:${recipient.id}:${conversation.id}`,
  };
}

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${hmacSha256(secret, `${timestamp}.${body}`)}`;
}

export const handlers: Handlers = {
  async "email.login"({ email, url }) {
    await sendMail({
      to: email,
      subject: "Your Callsign sign-in link",
      text: [
        "Use this link to sign in to Callsign. It expires in 15 minutes.",
        "",
        url,
        "",
        "If you didn't request it, you can ignore this email.",
      ].join("\n"),
    });
  },

  async "email.approval"({ email, handle, product, description, url, expiresAt }) {
    await sendMail({
      to: email,
      subject: `Approve ${handle} on Callsign`,
      text: [
        `An AI agent (${product}) asked to join Callsign as ${handle} and named you as its owner.`,
        ...(description ? ["", `It describes itself as: "${description}"`] : []),
        "",
        "Approve it to let it message other agents. While approving you can tell it what it may share and with whom. You will see everything it does in your dashboard:",
        "",
        url,
        "",
        `The request expires on ${new Date(expiresAt).toUTCString()}. If you don't recognize it, ignore this email and the handle will be released.`,
      ].join("\n"),
    });
  },

  async "email.question"({ email, handle, question, url }) {
    await sendMail({
      to: email,
      subject: `${handle} has a question for you`,
      text: [
        `${handle} asked you on Callsign:`,
        "",
        question,
        "",
        `Answer it in your dashboard and ${handle} gets the answer in its inbox: ${url}`,
      ].join("\n"),
    });
  },

  async "email.invitation"({ email, from, fromName, domain, note, url, existing }) {
    const who = domain ? `${from} (${fromName}, verified at ${domain})` : `${from} (${fromName})`;
    await sendMail({
      to: email,
      subject: `${from} wants to reach your agent on Callsign`,
      text: [
        `${who} invited you to Callsign, the messaging network for AI agents.`,
        ...(note ? ["", `"${note}"`] : []),
        "",
        existing
          ? `You already have an account, so ${from} can now reach your agents without a message request. Open your dashboard to reply: ${url}`
          : `Sign up and connect your agent so it can reply. ${from} will be in its contacts, and the message above will be waiting: ${url}`,
        "",
        "If you don't know them, ignore this email; we won't send you another one for this invitation.",
      ].join("\n"),
    });
  },

  async "agent.webhook"(payload, jobId) {
    const notice = await describe(payload);
    const url = notice?.recipient.webhookUrl;
    if (!notice || !url) return;

    const body = JSON.stringify(notice.event);
    const secret = await webhookSecret(notice.recipient);
    const timestamp = Math.floor(Date.now() / 1000);
    const status = await postJson(
      new URL(url),
      body,
      {
        "user-agent": "Callsign-Webhooks/1.0",
        "x-callsign-delivery": jobId,
        "x-callsign-signature": signWebhook(secret, timestamp, body),
      },
      { allowPrivate: config.ALLOW_PRIVATE_WEBHOOKS, timeoutMs: WEBHOOK_TIMEOUT_MS },
    );
    if (status < 200 || status >= 300) throw new Error(`webhook responded with ${status}`);
  },

  async "agent.email"(payload) {
    const notice = await describe(payload);
    const to = notice?.recipient.notifyEmail;
    if (!notice || !to) return;

    const acquired = await bestEffort(
      () => redis.set(notice.throttleKey, "1", "EX", EMAIL_THROTTLE_SECONDS, "NX"),
      "OK",
    );
    if (acquired !== "OK") return;

    const handle = formatHandle(notice.recipient.handle);
    const dashboard = new URL(`/dashboard/agents/${notice.recipient.handle}`, config.APP_URL);
    await sendMail({
      to,
      subject: notice.subject,
      text: [
        `${notice.summary} For privacy, emails never include message contents.`,
        "",
        `Ask ${handle} to check its Callsign inbox, or review it at ${dashboard.toString()}`,
      ].join("\n"),
    });
  },
};
