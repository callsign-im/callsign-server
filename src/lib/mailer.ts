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
};

export async function sendMail(mail: Mail): Promise<void> {
  await transport.sendMail({ from: config.MAIL_FROM, ...mail });
}
