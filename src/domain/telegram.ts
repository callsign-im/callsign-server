import { eq } from "drizzle-orm";
import { config, usesHttps } from "../config.ts";
import { db } from "../db/client.ts";
import { agents, ownerQuestions, owners, type Owner } from "../db/schema.ts";
import { randomToken } from "../lib/crypto.ts";
import { logger } from "../lib/logger.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { redis } from "../lib/redis.ts";
import { botUsername, telegram, telegramEnabled, telegramWebhookSecret } from "../lib/telegram.ts";
import { acknowledgeAlert, alertForTelegram, freezeFromAlert } from "./alerts.ts";
import { AppError } from "./errors.ts";
import { formatHandle } from "./handles.ts";
import { decideHoldFromTelegram, holdForApprover } from "./holds.ts";
import { ownerKey } from "./keys.ts";
import { answerQuestion, openQuestion, type Reply } from "./questions.ts";

const LINK_TTL_SECONDS = 600;
const QUESTION_TTL_SECONDS = 7 * 86_400;

const linkKey = (code: string) => `telegram-link:${code}`;
const questionKey = (chatId: string, messageId: number) =>
  `telegram-question:${chatId}:${messageId}`;

type Chat = { id: number; type: string };
type Message = {
  message_id: number;
  chat: Chat;
  text?: string;
  reply_to_message?: { message_id: number };
};
export type TelegramUpdate = {
  message?: Message;
  callback_query?: { id: string; data?: string; message?: Message };
};

export async function registerTelegramWebhook(): Promise<void> {
  if (!telegramEnabled() || !usesHttps) return;
  await telegram("setWebhook", {
    url: new URL("/v1/telegram/webhook", config.PUBLIC_API_URL).toString(),
    secret_token: telegramWebhookSecret(),
    allowed_updates: ["message", "callback_query"],
  });
  logger.info("telegram webhook registered");
}

export async function createTelegramLink(
  owner: Owner,
): Promise<{ url: string; expiresAt: string }> {
  if (!telegramEnabled()) throw new AppError("not_found", "Telegram isn't set up on this server.");
  await rateLimit(`telegram-link:${owner.id}`, 10, 3600);
  const code = randomToken();
  await redis.set(linkKey(code), owner.id, "EX", LINK_TTL_SECONDS);
  return {
    url: `https://t.me/${await botUsername()}?start=${code}`,
    expiresAt: new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString(),
  };
}

export async function unlinkTelegram(owner: Owner): Promise<void> {
  const chatId = owner.telegramChatId;
  await db.update(owners).set({ telegramChatId: null }).where(eq(owners.id, owner.id));
  if (chatId) {
    await say(
      chatId,
      "Disconnected from Callsign. Questions from your agents won't arrive here anymore.",
    );
  }
}

function say(chatId: string, text: string, extra: Record<string, unknown> = {}) {
  return telegram<{ message_id: number }>("sendMessage", { chat_id: chatId, text, ...extra });
}

async function ownerByChat(chatId: string): Promise<Owner | undefined> {
  const [owner] = await db.select().from(owners).where(eq(owners.telegramChatId, chatId));
  return owner;
}

export async function sendQuestionToTelegram({ questionId }: { questionId: string }) {
  const [found] = await db
    .select({ question: ownerQuestions, agent: agents, owner: owners })
    .from(ownerQuestions)
    .innerJoin(agents, eq(agents.id, ownerQuestions.agentId))
    .innerJoin(owners, eq(owners.id, agents.ownerId))
    .where(eq(ownerQuestions.id, questionId));
  const chatId = found?.owner.telegramChatId;
  if (!found || !chatId || found.question.answeredAt || !telegramEnabled()) return;

  const { question, context, options } = openQuestion(
    await ownerKey(found.owner.id),
    found.question,
  );
  const text = [
    `${formatHandle(found.agent.handle)} asks:`,
    "",
    question,
    ...(context ? ["", context] : []),
    "",
    options.length > 0
      ? "Tap an option, or reply to this message with something else."
      : "Reply to this message with your answer.",
  ].join("\n");
  const sent = await say(chatId, text, {
    reply_markup:
      options.length > 0
        ? {
            inline_keyboard: options.map((option, index) => [
              { text: option, callback_data: `answer:${questionId}:${index}` },
            ]),
          }
        : { force_reply: true, input_field_placeholder: "Your answer" },
  });
  await redis.set(questionKey(chatId, sent.message_id), questionId, "EX", QUESTION_TTL_SECONDS);
}

export async function sendAlertToTelegram({ alertId }: { alertId: string }) {
  if (!telegramEnabled()) return;
  const found = await alertForTelegram(alertId);
  if (!found) return;
  const { chatId, view } = found;
  const name = view.agent ?? "your agent";
  const { ip, network } = view.details;
  const text = [
    view.title,
    "",
    view.description,
    ...(ip ? [`Address: ${ip}${network ? ` (${network})` : ""}`] : []),
    "",
    `If it wasn't you, freeze ${name}: every call it makes is refused until you unfreeze it.`,
  ].join("\n");
  await say(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: `Freeze ${name}`, callback_data: `fz:${alertId}` },
          { text: "It was me", callback_data: `me:${alertId}` },
        ],
      ],
    },
  });
}

export async function sendHoldToTelegram({ holdId }: { holdId: string }) {
  if (!telegramEnabled()) return;
  const found = await holdForApprover(holdId);
  const chatId = found?.owner.telegramChatId;
  if (!found || !chatId) return;
  const { view, passkey, dashboard } = found;
  const text = [
    `${view.agent} wants to do this:`,
    "",
    view.summary,
    "",
    `Your rules hold it because ${view.why.join(" and ")}.`,
  ].join("\n");
  await say(chatId, text, {
    reply_markup: {
      inline_keyboard: passkey
        ? [
            [{ text: "Decline", callback_data: `hd:${holdId}` }],
            [{ text: "Approve in the dashboard", url: dashboard }],
          ]
        : [
            [
              { text: "Approve", callback_data: `ha:${holdId}` },
              { text: "Decline", callback_data: `hd:${holdId}` },
            ],
          ],
    },
  });
}

async function actOnHold(chatId: string, holdId: string, action: "ha" | "hd") {
  const owner = await ownerByChat(chatId);
  if (!owner) return { ok: false, text: "This chat isn't connected to Callsign anymore." } as const;
  try {
    const decided = await decideHoldFromTelegram(
      owner,
      holdId,
      action === "ha" ? "approve" : "deny",
    );
    return action === "ha"
      ? ({ ok: true, toast: "Approved.", text: `Approved. ${decided.agent} carries on.` } as const)
      : ({ ok: true, toast: "Declined.", text: `Declined. ${decided.agent} was told.` } as const);
  } catch (error) {
    if (error instanceof AppError) return { ok: false, text: error.message } as const;
    throw error;
  }
}

async function actOnAlert(chatId: string, alertId: string, action: "fz" | "me") {
  const owner = await ownerByChat(chatId);
  if (!owner) return { ok: false, text: "This chat isn't connected to Callsign anymore." } as const;
  try {
    if (action === "fz") {
      const agent = await freezeFromAlert(owner, alertId, "telegram");
      return {
        ok: true,
        toast: "Frozen.",
        text: `Frozen. Unfreeze ${formatHandle(agent.handle)} from your Callsign dashboard when it's safe.`,
      } as const;
    }
    await acknowledgeAlert(owner, alertId, "telegram");
    return { ok: true, toast: "Got it.", text: "Marked as you." } as const;
  } catch (error) {
    if (error instanceof AppError) return { ok: false, text: error.message } as const;
    throw error;
  }
}

async function answerFromChat(chatId: string, questionId: string, reply: Reply) {
  const owner = await ownerByChat(chatId);
  if (!owner) {
    return { ok: false, text: "This chat isn't connected to Callsign anymore." } as const;
  }
  try {
    const answered = await answerQuestion(owner.id, questionId, reply, "telegram");
    return { ok: true, text: answered.answer ?? "" } as const;
  } catch (error) {
    if (error instanceof AppError) {
      return { ok: false, text: error.message } as const;
    }
    throw error;
  }
}

async function onStart(chatId: string, code: string) {
  const ownerId = code ? await redis.getdel(linkKey(code)) : null;
  if (!ownerId) {
    await say(
      chatId,
      code
        ? "That link expired. Open your Callsign account page and connect Telegram again."
        : "To get your agents' questions here, open your Callsign account page and choose Connect Telegram.",
    );
    return;
  }
  await db.transaction(async (tx) => {
    await tx.update(owners).set({ telegramChatId: null }).where(eq(owners.telegramChatId, chatId));
    await tx.update(owners).set({ telegramChatId: chatId }).where(eq(owners.id, ownerId));
  });
  await say(
    chatId,
    "Connected. When one of your agents asks you something, it arrives here: tap an option or reply to answer. Send /stop to disconnect.",
  );
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const callback = update.callback_query;
  const [, action, targetId] = /^(fz|me|ha|hd):([0-9a-f-]{36})$/.exec(callback?.data ?? "") ?? [];
  if (callback && callback.message && action && targetId) {
    const { message } = callback;
    const chatId = String(message.chat.id);
    const outcome =
      action === "fz" || action === "me"
        ? await actOnAlert(chatId, targetId, action)
        : await actOnHold(chatId, targetId, action as "ha" | "hd");
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: outcome.ok ? outcome.toast : outcome.text,
    });
    if (outcome.ok) {
      await telegram("editMessageText", {
        chat_id: chatId,
        message_id: message.message_id,
        text: `${message.text ?? ""}\n\n${outcome.text}`,
      });
    }
    return;
  }
  if (callback) {
    const [, questionId, index] = /^answer:([0-9a-f-]{36}):(\d)$/.exec(callback.data ?? "") ?? [];
    const message = callback.message;
    if (!questionId || !message) {
      await telegram("answerCallbackQuery", { callback_query_id: callback.id });
      return;
    }
    const chatId = String(message.chat.id);
    const outcome = await answerFromChat(chatId, questionId, { option: Number(index) });
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: outcome.ok ? "Sent to your agent." : outcome.text,
    });
    if (outcome.ok) {
      await telegram("editMessageText", {
        chat_id: chatId,
        message_id: message.message_id,
        text: `${message.text ?? ""}\n\nYou answered: ${outcome.text}`,
      });
    }
    return;
  }

  const message = update.message;
  if (!message?.text || message.chat.type !== "private") return;
  const chatId = String(message.chat.id);
  const text = message.text.trim();
  if (text === "/start" || text.startsWith("/start ")) return onStart(chatId, text.slice(7).trim());
  if (text === "/stop") {
    const owner = await ownerByChat(chatId);
    if (owner) return unlinkTelegram(owner);
    await say(chatId, "This chat isn't connected to Callsign.");
    return;
  }

  const replyTo = message.reply_to_message?.message_id;
  const questionId = replyTo ? await redis.get(questionKey(chatId, replyTo)) : null;
  if (!questionId) {
    await say(chatId, "To answer a question, tap one of its options or reply to it.");
    return;
  }
  const outcome = await answerFromChat(chatId, questionId, text);
  await say(chatId, outcome.ok ? "Sent to your agent." : outcome.text, {
    reply_parameters: { message_id: message.message_id },
  });
}
