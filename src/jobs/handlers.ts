import { config, supportEmail } from "../config.ts";
import { webhookSecret } from "../domain/agents.ts";
import { sendAlertEmail } from "../domain/alerts.ts";
import { syncConnection } from "../domain/connections.ts";
import { formatHandle } from "../domain/handles.ts";
import { deliverBridgeEmail } from "../domain/email-bridge.ts";
import { receiveBridgeEmail } from "../domain/email-inbound.ts";
import { fireFollowUp } from "../domain/follow-ups.ts";
import { helloReply } from "../domain/hello.ts";
import { emailHold, expireHold, releaseApproved } from "../domain/holds.ts";
import { describeNotification } from "../domain/notifications.ts";
import { runPasskeyReset } from "../domain/passkeys.ts";
import { remindOverdueTask } from "../domain/plans.ts";
import { checkSighting } from "../domain/sightings.ts";
import {
  sendAlertToTelegram,
  sendHoldToTelegram,
  sendQuestionToTelegram,
} from "../domain/telegram.ts";
import { deliverEvent, fanOutEvent } from "../domain/subscriptions.ts";
import { deliverWake } from "../domain/wake.ts";
import { hmacSha256 } from "../lib/crypto.ts";
import { sendMail } from "../lib/mailer.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import { postJson } from "../lib/safe-fetch.ts";
import type { JobKind, JobPayloads, PasskeyChange } from "./queue.ts";

const WEBHOOK_TIMEOUT_MS = 10_000;
const EMAIL_THROTTLE_SECONDS = 900;

type Handlers = { [K in JobKind]: (payload: JobPayloads[K], jobId: string) => Promise<void> };

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${hmacSha256(secret, `${timestamp}.${body}`)}`;
}

function passkeyMail(
  change: PasskeyChange,
  { name, runAt, cancelUrl }: { name?: string; runAt?: string; cancelUrl?: string },
): { subject: string; lines: string[] } {
  const notYou = `If it wasn't you, contact ${supportEmail} right away.`;
  switch (change) {
    case "added":
      return {
        subject: "A passkey was added to your Callsign account",
        lines: [
          `The passkey "${name}" was added to your account. From now on Callsign asks for it before sensitive changes, like connecting apps, creating tokens or unfreezing an agent.`,
          "",
          `If you didn't add it, remove it from your account page. ${notYou}`,
        ],
      };
    case "removed":
      return {
        subject: "A passkey was removed from your Callsign account",
        lines: [`The passkey "${name}" was removed from your account.`, "", notYou],
      };
    case "reset_requested":
      return {
        subject: "Your Callsign passkeys will be removed",
        lines: [
          `Someone signed in to your account and asked to remove every passkey, which is how you recover after losing them. It happens on ${runAt ? new Date(runAt).toUTCString() : "in 72 hours"}.`,
          "",
          "If it wasn't you, cancel it now. Someone may have access to your email:",
          "",
          cancelUrl ?? "",
        ],
      };
    case "reset_cancelled":
      return {
        subject: "Passkey removal cancelled",
        lines: ["The request to remove your passkeys was cancelled. They keep working."],
      };
    case "reset_done":
      return {
        subject: "Your Callsign passkeys were removed",
        lines: [
          "As requested 72 hours ago, every passkey was removed from your account. You can add a new one from your account page.",
          "",
          notYou,
        ],
      };
  }
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

  async "email.report"({ email, handle, reason, reporters, suspended, url }) {
    await sendMail({
      to: email,
      subject: suspended
        ? `${handle} was suspended after ${reporters} reports`
        : `${handle} was reported for ${reason}`,
      text: [
        `${handle} was reported for ${reason}. ${reporters} owner${reporters === 1 ? " has" : "s have"} reported it in the last 24 hours.`,
        ...(suspended
          ? ["", "That reached the limit, so it was suspended until you review it."]
          : []),
        "",
        `Review the report and the messages it sent: ${url}`,
      ].join("\n"),
    });
  },

  async "email.suspended"({ email, handle }) {
    await sendMail({
      to: email,
      subject: `${handle} was suspended on Callsign`,
      text: [
        `Several people reported messages from your agent ${handle}, so we suspended it while we review them. It can't send or receive messages until then.`,
        "",
        `If you think this is a mistake, reply to ${supportEmail} with the handle and what the agent was doing.`,
      ].join("\n"),
    });
  },

  async "email.question"({ email, handle, question, url, answerUrl, options = [] }) {
    const choices = answerUrl
      ? options.map((option, index) => `- ${option}: ${answerUrl}&option=${index}`)
      : [];
    await sendMail({
      to: email,
      subject: `${handle} has a question for you`,
      text: [
        `${handle} asked you on Callsign:`,
        "",
        question,
        "",
        ...(choices.length > 0
          ? ["Pick an answer (you'll confirm it on the next page):", ...choices, ""]
          : []),
        answerUrl
          ? `Answer from any device, no sign-in needed: ${answerUrl}`
          : `Answer it in your dashboard: ${url}`,
        "",
        `${handle} gets the answer in its inbox. Don't forward this email: its links answer for you.`,
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
    const notice = await describeNotification(payload);
    const url = notice?.recipient.webhookUrl;
    if (!notice || !url) return;

    const body = JSON.stringify(notice.event);
    const secret = await webhookSecret(notice.recipient);
    const timestamp = Math.floor(Date.now() / 1000);
    const { status } = await postJson(
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
    const notice = await describeNotification(payload);
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

  async "email.passkey"({ email, change, ...details }) {
    const { subject, lines } = passkeyMail(change, details);
    await sendMail({ to: email, subject, text: lines.join("\n") });
  },

  "agent.wake": deliverWake,
  "telegram.question": sendQuestionToTelegram,
  "hello.reply": helloReply,
  "email.bridge": deliverBridgeEmail,
  "email.inbound": receiveBridgeEmail,
  "task.due": remindOverdueTask,
  "follow_up.due": fireFollowUp,
  "agent.events": fanOutEvent,
  "event.delivery": deliverEvent,
  "passkey.reset": runPasskeyReset,
  "sighting.check": checkSighting,
  "alert.email": sendAlertEmail,
  "alert.telegram": sendAlertToTelegram,
  async "hold.notify"(payload) {
    await emailHold(payload);
    await sendHoldToTelegram(payload);
  },
  "hold.release": releaseApproved,
  async "connection.sync"(payload) {
    await syncConnection(payload);
  },
  async "email.share"({ email, sharer, group, connection, tools, url }) {
    await sendMail({
      to: email,
      subject: `${sharer} shared ${connection} with ${group}`,
      text: [
        `${sharer} shared tools from ${connection} with ${group} on Callsign: ${tools.join(", ")}.`,
        "",
        `Your agents in ${group} can call them now. Calls run with ${sharer}'s owner's access, and that owner sees what your agents send to them.`,
        "",
        `If you'd rather your agent didn't use them, turn them off: ${url}`,
      ].join("\n"),
    });
  },
  "hold.expire": expireHold,
};
