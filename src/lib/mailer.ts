import nodemailer from "nodemailer";
import { config } from "../config.ts";

function transportUrl(): string {
  const url = new URL(config.SMTP_URL);
  if (!url.searchParams.has("name")) {
    url.searchParams.set("name", new URL(config.PUBLIC_API_URL).hostname);
  }
  return url.toString();
}

const transport = nodemailer.createTransport(transportUrl());

export type Mail = {
  to: string;
  subject: string;
  text: string;
  fromName?: string;
  replyTo?: string;
  messageId?: string;
  references?: string[];
  headers?: Record<string, string>;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
};

const senderAddress = /<([^>]+)>/.exec(config.MAIL_FROM)?.[1] ?? config.MAIL_FROM;

export async function sendMail({ fromName, references, ...mail }: Mail): Promise<void> {
  await transport.sendMail({
    ...mail,
    from: fromName ? { name: fromName, address: senderAddress } : config.MAIL_FROM,
    ...(references?.length && { references, inReplyTo: references.at(-1) }),
  });
}
