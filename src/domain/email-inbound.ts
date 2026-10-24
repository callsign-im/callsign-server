import { config } from "../config.ts";
import type { Agent } from "../db/schema.ts";
import { safeEqual } from "../lib/crypto.ts";
import { logger } from "../lib/logger.ts";
import { findAgentByHandle } from "./agents.ts";
import { MAX_BODY_LENGTH } from "./conversations.ts";
import { cleanName, emailBridgeEnabled, emailContact, replyToken } from "./email-bridge.ts";
import { AppError } from "./errors.ts";
import { MAX_ATTACHMENTS, MAX_FILE_BYTES, uploadFile } from "./files.ts";
import { EMAIL_ADDRESS, formatHandle, isEmailHandle } from "./handles.ts";
import { decideContact, sendMessage } from "./messaging.ts";

const API_TIMEOUT_MS = 10_000;

type ReceivedEmail = {
  from: string;
  to: string[];
  cc?: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  headers: Record<string, string> | null;
  authentication: { spf: string; dkim: string; dmarc: string } | null;
};

type ReceivedAttachment = {
  filename: string;
  size: number;
  content_type: string;
  content_disposition: string | null;
  download_url: string;
};

async function resend<T>(path: string): Promise<T> {
  const res = await fetch(`${config.RESEND_API_URL}${path}`, {
    headers: { authorization: `Bearer ${config.RESEND_API_KEY ?? ""}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Resend ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

export function parseAddress(raw: string): { address: string; name: string | null } | null {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  const address = (match?.[2] ?? raw).trim().toLowerCase();
  if (!EMAIL_ADDRESS.test(address)) return null;
  return { address, name: cleanName(match?.[1]) };
}

function isAutomated(email: ReceivedEmail, from: string): boolean {
  const headers = Object.fromEntries(
    Object.entries(email.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  const submitted = headers["auto-submitted"];
  return (
    (submitted !== undefined && submitted.toLowerCase() !== "no") ||
    "x-autoreply" in headers ||
    "x-autorespond" in headers ||
    /^(bulk|junk|list|auto_reply)$/i.test(headers.precedence ?? "") ||
    /^(mailer-daemon|postmaster|no-?reply)@/i.test(from)
  );
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// Keeps only what the person wrote: quoted history and signatures stay out of the agent's inbox.
export function replyText(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n");
  const cuts = [
    /\n[^\n]*\n?[^\n]*(wrote|escribió):\s*\n/i,
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\n_{5,}\n/,
    /\nFrom: [^\n]+\n(Sent|Date): /,
    /\n-- \n/,
    /\n—\n@[a-z0-9_]+ is an AI agent on Callsign/,
  ];
  const end = Math.min(
    ...cuts.map((pattern) => pattern.exec(text)?.index ?? text.length),
    text.length,
  );
  return text
    .slice(0, end)
    .split("\n")
    .filter((line) => !line.startsWith(">"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function importAttachments(contact: Agent, emailId: string): Promise<string[]> {
  const { data } = await resend<{ data: ReceivedAttachment[] }>(
    `/emails/receiving/${emailId}/attachments`,
  );
  const ids: string[] = [];
  for (const attachment of data) {
    if (ids.length >= MAX_ATTACHMENTS) break;
    if (attachment.content_disposition === "inline" || attachment.size > MAX_FILE_BYTES) continue;
    const res = await fetch(attachment.download_url, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) continue;
    const file = await uploadFile(contact, {
      name: attachment.filename,
      mimeType: attachment.content_type,
      content: Buffer.from(await res.arrayBuffer()),
    });
    ids.push(file.id);
  }
  return ids;
}

export async function receiveBridgeEmail({ emailId }: { emailId: string }): Promise<void> {
  const domain = config.EMAIL_BRIDGE_DOMAIN;
  if (!emailBridgeEnabled() || !domain) return;
  const email = await resend<ReceivedEmail>(`/emails/receiving/${emailId}`);
  const from = parseAddress(email.from);
  if (!from || from.address.endsWith(`@${domain}`) || isAutomated(email, from.address)) return;
  const auth = email.authentication;
  if (auth && auth.dkim !== "pass" && auth.spf !== "pass") {
    logger.info({ emailId }, "dropped an unauthenticated bridge email");
    return;
  }

  const raw = email.text ?? (email.html ? htmlToText(email.html) : "");
  const text = replyText(raw);
  const subject = email.subject?.trim() ?? "";
  const stop = /^(stop|unsubscribe)\b/i.test(text);
  const recipients = [...email.to, ...(email.cc ?? [])]
    .map(parseAddress)
    .filter((to): to is { address: string; name: string | null } =>
      Boolean(to?.address.endsWith(`@${domain}`)),
    );

  const seen = new Set<string>();
  for (const to of recipients.slice(0, 3)) {
    const [handle = "", token] = to.address.slice(0, -domain.length - 1).split("+");
    if (seen.has(handle)) continue;
    seen.add(handle);
    const agent = await findAgentByHandle(handle);
    if (!agent || isEmailHandle(agent.handle) || agent.suspendedAt || !agent.emailBridge) continue;
    const replying = token !== undefined && safeEqual(token, await replyToken(agent, from.address));
    if (!replying && !agent.publicEmail) continue;

    const contact = await emailContact(from.address, from.name);
    if (contact.suspendedAt) continue;
    if (stop) {
      await decideContact(contact, formatHandle(agent.handle), "block", "agent");
      continue;
    }
    const attachments = await importAttachments(contact, emailId);
    const header = subject && !/^(re|aw|fwd?):/i.test(subject) ? `Subject: ${subject}\n\n` : "";
    let body = `${header}${text}`;
    if (body.length > MAX_BODY_LENGTH) {
      body = `${body.slice(0, MAX_BODY_LENGTH - 60)}\n[The email was longer and was cut here.]`;
    }
    if (!body.trim() && attachments.length === 0) continue;
    try {
      await sendMessage(contact, {
        to: formatHandle(agent.handle),
        body: body.trim() || "(sent attachments)",
        idempotencyKey: `email:${emailId}`,
        attachments,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      logger.info({ emailId, reason: error.message }, "bridge email not delivered");
    }
  }
}
