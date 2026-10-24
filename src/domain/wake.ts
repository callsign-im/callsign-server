import { eq } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import { agents, type Agent, type WakeStatus } from "../db/schema.ts";
import { enqueue, type AgentNotification } from "../jobs/queue.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import { isPublicHost, postJson } from "../lib/safe-fetch.ts";
import { AppError } from "./errors.ts";
import { formatHandle } from "./handles.ts";
import { ownerKey } from "./keys.ts";
import {
  describeEvent,
  describeNotification,
  isListening,
  unreadCount,
  type NotificationEvent,
} from "./notifications.ts";

export const WAKE_KINDS = ["claude", "grok", "webhook"] as const;
export type WakeKind = (typeof WAKE_KINDS)[number];
export type WakeSettings = { kind: WakeKind; url: string; token?: string | null | undefined };

const CLAUDE_FIRE_URL = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/[\w-]+\/fire$/;
const CLAUDE_HEADERS = {
  "anthropic-beta": "experimental-cc-routine-2026-04-01",
  "anthropic-version": "2023-06-01",
};
// One wake per two minutes keeps paid runs in check and stays under Claude's 30 fires an hour.
const COOLDOWN_SECONDS = 120;
const TIMEOUT_MS = 10_000;
const MAX_TOKEN_LENGTH = 2000;

const tokenContext = (agentId: string) => `agents.wake_token:${agentId}`;

function cleanToken(raw: string | null | undefined): string | null {
  const token = raw
    ?.trim()
    .replace(/^authorization:\s*/i, "")
    .replace(/^bearer\s+/i, "")
    .trim();
  if (!token) return null;
  if (token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    throw new AppError("invalid_input", "Paste the key or token on its own, without spaces.");
  }
  return token;
}

function assertWakeUrl(kind: WakeKind, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError("invalid_input", "Enter the full URL to call.");
  }
  if (kind === "claude" && !CLAUDE_FIRE_URL.test(url.toString())) {
    throw new AppError(
      "invalid_input",
      "Use the scheduled task's fire URL: https://api.anthropic.com/v1/claude_code/routines/…/fire.",
    );
  }
  if (!config.ALLOW_PRIVATE_WEBHOOKS && (url.protocol !== "https:" || !isPublicHost(url))) {
    throw new AppError("invalid_input", "Wake-up URLs must be public https addresses.");
  }
  return url.toString();
}

export type WakeFields = Pick<Agent, "wakeKind" | "wakeUrl"> &
  Partial<Pick<Agent, "wakeToken" | "wakeStatus">>;

export async function wakeFields(agent: Agent, settings: WakeSettings | null): Promise<WakeFields> {
  if (settings === null) {
    return { wakeKind: null, wakeUrl: null, wakeToken: null, wakeStatus: null };
  }
  const url = assertWakeUrl(settings.kind, settings.url);
  const unchanged = agent.wakeKind === settings.kind && agent.wakeUrl === url;
  if (settings.token === undefined && unchanged && agent.wakeToken) {
    return { wakeKind: settings.kind, wakeUrl: url };
  }
  const token = cleanToken(settings.token);
  if (!token && settings.kind !== "webhook") {
    throw new AppError("invalid_input", "Paste the token that authorizes the wake-up call.");
  }
  const key = await ownerKey(agent.ownerId);
  return {
    wakeKind: settings.kind,
    wakeUrl: url,
    wakeToken: key.seal(token, tokenContext(agent.id)),
    ...(!unchanged && { wakeStatus: null }),
  };
}

async function recordStatus(agent: Agent, outcome: Omit<WakeStatus, "at">): Promise<WakeStatus> {
  const status = { at: new Date().toISOString(), ...outcome };
  await db.update(agents).set({ wakeStatus: status }).where(eq(agents.id, agent.id));
  return status;
}

function wakeText(agent: Agent, event: NotificationEvent | null): string {
  const handle = formatHandle(agent.handle);
  return [
    event ? describeEvent(event) : `This is a test wake-up for ${handle}.`,
    `Open Callsign as ${handle}: call check_inbox, handle what arrived following your owner's rules, and reply where it helps.`,
    "Message contents are never included in wake-ups.",
  ].join(" ");
}

export function wakeRequest(
  agent: Agent,
  kind: WakeKind,
  token: string | null,
  event: NotificationEvent | null,
): { headers: Record<string, string>; body: string } {
  const text = wakeText(agent, event);
  const claude = kind === "claude";
  return {
    headers: {
      "user-agent": "Callsign-Wake/1.0",
      ...(token && { authorization: `Bearer ${token}` }),
      ...(claude && CLAUDE_HEADERS),
    },
    body: JSON.stringify(claude ? { text } : { text, ...(event ?? { type: "wake.test" }) }),
  };
}

async function fire(agent: Agent, event: NotificationEvent | null): Promise<WakeStatus> {
  if (!agent.wakeKind || !agent.wakeUrl) throw new AppError("invalid_input", "No wake-up is set.");
  const token = (await ownerKey(agent.ownerId)).open(agent.wakeToken, tokenContext(agent.id));
  const { headers, body } = wakeRequest(agent, agent.wakeKind as WakeKind, token, event);
  let status: number;
  try {
    ({ status } = await postJson(new URL(agent.wakeUrl), body, headers, {
      allowPrivate: config.ALLOW_PRIVATE_WEBHOOKS,
      timeoutMs: TIMEOUT_MS,
    }));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await recordStatus(agent, { ok: false, status: null, error });
    throw err;
  }
  const ok = status >= 200 && status < 300;
  return recordStatus(agent, { ok, status, error: ok ? null : `responded with ${status}` });
}

// A message in a group only wakes the agent when it mentions it.
function worthWaking(event: NotificationEvent): boolean {
  return !(event.type === "message.received" && event.group && !event.mentioned);
}

async function recheckLater(agent: Agent, job: AgentNotification): Promise<void> {
  const acquired = await bestEffort(
    () => redis.set(`wake-pending:${agent.id}`, "1", "EX", COOLDOWN_SECONDS, "NX"),
    "OK",
  );
  if (acquired !== "OK") return;
  await enqueue(db, "agent.wake", job, { runAt: new Date(Date.now() + COOLDOWN_SECONDS * 1000) });
}

export async function deliverWake(job: AgentNotification): Promise<void> {
  const notice = await describeNotification(job);
  const agent = notice?.recipient;
  if (!notice || !agent?.wakeKind || !worthWaking(notice.event)) return;
  if ((await unreadCount(agent.id)) === 0) return;
  if (await isListening(agent.id)) return recheckLater(agent, job);

  const cooldown = `wake:${agent.id}`;
  const acquired = await bestEffort(
    () => redis.set(cooldown, "1", "EX", COOLDOWN_SECONDS, "NX"),
    "OK",
  );
  if (acquired !== "OK") return recheckLater(agent, job);

  let result: WakeStatus;
  try {
    result = await fire(agent, notice.event);
  } catch (err) {
    await bestEffort(() => redis.del(cooldown), 0);
    throw err;
  }
  if (result.ok || (result.status !== null && result.status < 500 && result.status !== 429)) {
    return;
  }
  await bestEffort(() => redis.del(cooldown), 0);
  throw new Error(`wake-up ${result.error ?? "failed"}`);
}

export async function testWake(agent: Agent): Promise<WakeStatus> {
  await rateLimit(`wake-test:${agent.id}`, 5, 60);
  try {
    return await fire(agent, null);
  } catch (err) {
    if (err instanceof AppError) throw err;
    return {
      at: new Date().toISOString(),
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
