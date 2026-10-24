import { and, asc, desc, eq, isNull, lt } from "drizzle-orm";
import { config, siteDomain } from "../config.ts";
import { db } from "../db/client.ts";
import { agents, conversations, messages, owners, type Agent } from "../db/schema.ts";
import type { AgentNotification } from "../jobs/queue.ts";
import { hmacSha256, safeEqual, standardSignature } from "../lib/crypto.ts";
import { uuidv7 } from "../lib/ids.ts";
import { sendMail } from "../lib/mailer.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { findAgentByHandle, newWebhookSecret, webhookSecret } from "./agents.ts";
import { bodyContext } from "./conversations.ts";
import { AppError } from "./errors.ts";
import { attachmentsFor, readFile } from "./files.ts";
import { EMAIL_ADDRESS, formatHandle, isEmailHandle, normalizeHandle } from "./handles.ts";
import { organizationDomain } from "./identity.ts";
import { conversationKey } from "./keys.ts";
import { upsertOwner } from "./owners.ts";

// The email bridge lets agents write to people who aren't on Callsign. Each address becomes an
// agent-like contact owned by the bridge, so requests, blocking, the inbox and the ledger work
// unchanged; delivery to it is an email, and replies come back through Resend Inbound.
const CONTACT_DESCRIPTION =
  "An email address outside Callsign. Messages to it are sent as email, and replies come back here.";
const EMAILS_PER_DAY = 50;
const SIGNATURE_TOLERANCE_SECONDS = 300;

export function emailBridgeEnabled(): boolean {
  return Boolean(
    config.EMAIL_BRIDGE_DOMAIN && config.RESEND_API_KEY && config.RESEND_WEBHOOK_SECRET,
  );
}

export function bridgeOwnerEmail(): string {
  return `bridge@${siteDomain}`;
}

export function emailAddressOf(agent: Agent): string | null {
  return emailBridgeEnabled() && agent.emailBridge && !isEmailHandle(agent.handle)
    ? `${agent.handle}@${config.EMAIL_BRIDGE_DOMAIN}`
    : null;
}

export async function replyToken(agent: Agent, email: string): Promise<string> {
  return hmacSha256(await webhookSecret(agent), `email-bridge:${email}`).slice(0, 16);
}

export function cleanName(name: string | null | undefined): string | null {
  const cleaned = name?.replace(/["<>]/g, "").trim();
  return cleaned ? cleaned.slice(0, 80) : null;
}

export async function emailContact(rawEmail: string, name?: string | null): Promise<Agent> {
  const email = normalizeHandle(rawEmail);
  if (!EMAIL_ADDRESS.test(email) || email.length > 254) {
    throw new AppError("invalid_input", `${rawEmail} isn't an email address.`);
  }
  const existing = await findAgentByHandle(email);
  const displayName = cleanName(name);
  if (existing && displayName && existing.displayName === existing.handle) {
    const [named] = await db
      .update(agents)
      .set({ displayName })
      .where(eq(agents.id, existing.id))
      .returning();
    return named ?? existing;
  }
  if (existing) return existing;
  const owner = await upsertOwner(db, bridgeOwnerEmail());
  const id = uuidv7();
  const [created] = await db
    .insert(agents)
    .values({
      id,
      ownerId: owner.id,
      handle: email,
      displayName: displayName ?? email,
      description: CONTACT_DESCRIPTION,
      product: "custom",
      discoverable: false,
      emailBridge: false,
      webhookSecret: await newWebhookSecret(owner.id, id),
    })
    .onConflictDoNothing({ target: agents.handle })
    .returning();
  const contact = created ?? (await findAgentByHandle(email));
  if (!contact) throw new Error("email contact disappeared after insert");
  return contact;
}

// The recipient of a send_message addressed to an email. People who already have an agent here
// should be reached there instead.
export async function emailRecipient(sender: Agent, raw: string): Promise<Agent> {
  const email = normalizeHandle(raw);
  if (!emailBridgeEnabled()) {
    throw new AppError(
      "invalid_input",
      "This Callsign server can't send email. Look for the person's agent with find_agent, or invite them with invite_person.",
    );
  }
  if (isEmailHandle(sender.handle) || !sender.emailBridge) {
    throw new AppError("forbidden", `Email is turned off for ${formatHandle(sender.handle)}.`);
  }
  const [theirs] = await db
    .select({ handle: agents.handle })
    .from(agents)
    .innerJoin(owners, eq(owners.id, agents.ownerId))
    .where(and(eq(owners.email, email), eq(agents.discoverable, true), isNull(agents.suspendedAt)))
    .orderBy(desc(agents.primary), asc(agents.createdAt))
    .limit(1);
  if (theirs) {
    throw new AppError(
      "conflict",
      `${email} has an agent on Callsign: ${formatHandle(theirs.handle)}. Message it there instead.`,
    );
  }
  await rateLimit(`email-out:${sender.id}`, EMAILS_PER_DAY, 86_400);
  return emailContact(email);
}

async function agentById(id: string): Promise<Agent | undefined> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  return agent;
}

export async function deliverBridgeEmail(job: AgentNotification): Promise<void> {
  if (job.kind !== "request" && job.kind !== "message") return;
  const recipient = await agentById(job.agentId);
  if (!recipient || !isEmailHandle(recipient.handle) || !config.EMAIL_BRIDGE_DOMAIN) return;
  const [row] = await db
    .select({ message: messages, conversation: conversations, sender: agents, owner: owners })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(agents, eq(agents.id, messages.senderId))
    .innerJoin(owners, eq(owners.id, agents.ownerId))
    .where(and(eq(messages.conversationId, job.conversationId), eq(messages.seq, job.seq)));
  if (!row || isEmailHandle(row.sender.handle)) return;
  const { message, conversation, sender, owner } = row;

  const body = (await conversationKey(conversation)).open(message.body, bodyContext(message.id));
  const files = (await attachmentsFor([message.id])).get(message.id) ?? [];
  const attachments = await Promise.all(
    files.map(async (file) => {
      const { content } = await readFile(recipient, file.id);
      return { filename: file.name, content, contentType: file.mimeType };
    }),
  );
  const earlier = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversation.id),
        eq(messages.senderId, sender.id),
        lt(messages.seq, message.seq),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(10);
  const messageId = (id: string) => `<${id}@${config.EMAIL_BRIDGE_DOMAIN}>`;
  const handle = formatHandle(sender.handle);
  const org = owner.showDomain ? organizationDomain(owner.email) : null;

  await sendMail({
    to: recipient.handle,
    fromName: `${sender.displayName} via Callsign`,
    replyTo: `${sender.handle}+${await replyToken(sender, recipient.handle)}@${config.EMAIL_BRIDGE_DOMAIN}`,
    subject: `${earlier.length > 0 ? "Re: " : ""}Message from ${sender.displayName} (${handle})`,
    messageId: messageId(message.id),
    references: earlier.reverse().map((m) => messageId(m.id)),
    headers: { "X-Callsign-Agent": handle },
    attachments,
    text: [
      body,
      "",
      "—",
      `${handle} is an AI agent on Callsign${org ? `, writing for someone at ${org}` : ""}. Reply to this email to answer; your reply goes straight to the agent.`,
      `Reply "stop" and ${handle} won't email you again.`,
    ].join("\n"),
  });
}

export function verifyResendWebhook(
  headers: { id?: string; timestamp?: string; signature?: string },
  body: string,
): boolean {
  const secret = config.RESEND_WEBHOOK_SECRET;
  const timestamp = Number(headers.timestamp);
  if (!secret || !headers.id || !headers.signature || !Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  let expected: string;
  try {
    expected = standardSignature(secret, headers.id, timestamp, body);
  } catch {
    return false;
  }
  return headers.signature.split(" ").some((candidate) => safeEqual(candidate, expected));
}
