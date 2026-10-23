import { and, eq } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import { agents, messages, type Agent, type Message } from "../db/schema.ts";
import { formatHandle } from "../domain/handles.ts";
import { hmacSha256 } from "../lib/crypto.ts";
import { sendMail } from "../lib/mailer.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import type { AgentNotification, JobKind, JobPayloads } from "./queue.ts";

const WEBHOOK_TIMEOUT_MS = 10_000;
const EMAIL_THROTTLE_SECONDS = 900;
const PREVIEW_LENGTH = 280;

type Handlers = { [K in JobKind]: (payload: JobPayloads[K], jobId: string) => Promise<void> };

async function loadDelivery(payload: AgentNotification) {
  const [row] = await db
    .select({ message: messages, sender: agents })
    .from(messages)
    .innerJoin(agents, eq(agents.id, messages.senderId))
    .where(and(eq(messages.conversationId, payload.conversationId), eq(messages.seq, payload.seq)));
  const [recipient] = await db.select().from(agents).where(eq(agents.id, payload.agentId));
  return row && recipient ? { ...row, recipient } : null;
}

function preview(body: string): string {
  return body.length > PREVIEW_LENGTH ? `${body.slice(0, PREVIEW_LENGTH)}…` : body;
}

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${hmacSha256(secret, `${timestamp}.${body}`)}`;
}

function webhookEvent(
  kind: AgentNotification["kind"],
  recipient: Agent,
  sender: Agent,
  message: Message,
) {
  return {
    type: kind === "request" ? "request.received" : "message.received",
    agent: formatHandle(recipient.handle),
    from: formatHandle(sender.handle),
    conversationId: message.conversationId,
    messageId: message.id,
    preview: preview(message.body),
    sentAt: message.createdAt.toISOString(),
  };
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

  async "agent.webhook"(payload, jobId) {
    const delivery = await loadDelivery(payload);
    const url = delivery?.recipient.webhookUrl;
    if (!delivery || !url) return;

    const body = JSON.stringify(
      webhookEvent(payload.kind, delivery.recipient, delivery.sender, delivery.message),
    );
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Callsign-Webhooks/1.0",
        "x-callsign-delivery": jobId,
        "x-callsign-signature": signWebhook(delivery.recipient.webhookSecret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`webhook responded with ${response.status}`);
  },

  async "agent.email"(payload) {
    const delivery = await loadDelivery(payload);
    const to = delivery?.recipient.notifyEmail;
    if (!delivery || !to) return;

    const throttleKey = `notify-email:${payload.agentId}:${payload.conversationId}`;
    const acquired = await bestEffort(
      () => redis.set(throttleKey, "1", "EX", EMAIL_THROTTLE_SECONDS, "NX"),
      "OK",
    );
    if (acquired !== "OK") return;

    const recipient = formatHandle(delivery.recipient.handle);
    const sender = formatHandle(delivery.sender.handle);
    const dashboard = new URL(`/dashboard/agents/${delivery.recipient.handle}`, config.WEB_URL);
    await sendMail({
      to,
      subject: `${sender} sent a message to ${recipient} on Callsign`,
      text: [
        `${sender} sent a message to ${recipient}:`,
        "",
        preview(delivery.message.body)
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
        "",
        `Ask ${recipient} to check its Callsign inbox, or review the conversation at ${dashboard.toString()}`,
      ].join("\n"),
    });
  },
};
