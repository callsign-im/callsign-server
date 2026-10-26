import { config } from "../config.ts";
import { hmacSha256 } from "./crypto.ts";
import { logger } from "./logger.ts";

const TIMEOUT_MS = 10_000;

export function telegramEnabled(): boolean {
  return config.TELEGRAM_BOT_TOKEN !== undefined;
}

// Telegram echoes this in X-Telegram-Bot-Api-Secret-Token on every webhook call.
export function telegramWebhookSecret(): string {
  return hmacSha256(config.TELEGRAM_BOT_TOKEN ?? "", "callsign-telegram-webhook");
}

export async function telegram<T>(method: string, body: Record<string, unknown>): Promise<T> {
  if (!config.TELEGRAM_BOT_TOKEN) throw new Error("Telegram isn't configured");
  const res = await fetch(`${config.TELEGRAM_API_URL}/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
  return data.result as T;
}

let username: Promise<string> | undefined;

export function botUsername(): Promise<string> {
  username ??= telegram<{ username: string }>("getMe", {})
    .then((me) => me.username)
    .catch((error: unknown) => {
      username = undefined;
      throw error;
    });
  return username;
}

/** Best effort: Telegram is a second channel, so a failure here never blocks the caller. */
export async function tellOwnerOnTelegram(
  owner: { telegramChatId: string | null },
  text: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  if (!owner.telegramChatId || !telegramEnabled()) return false;
  try {
    await telegram("sendMessage", { chat_id: owner.telegramChatId, text, ...extra });
    return true;
  } catch (error) {
    logger.warn({ err: error }, "telegram message failed");
    return false;
  }
}
