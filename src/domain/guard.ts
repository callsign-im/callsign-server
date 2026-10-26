import type { Agent } from "../db/schema.ts";
import { logger } from "../lib/logger.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import { raiseAlert } from "./alerts.ts";
import { maybeHold, type Held } from "./holds.ts";
import { createGroup, inviteToGroup } from "./groups.ts";
import { invitePerson } from "./invitations.ts";
import { sendMessage } from "./messaging.ts";
import type { Seen } from "./sightings.ts";

/**
 * Actions an agent takes through its own credentials (MCP tools and the agent REST API) go
 * through here. Internal callers like @hello or inbound email use the domain functions
 * directly; a lint rule keeps the two agent-facing surfaces from doing the same.
 */
export type AgentContext = { agent: Agent; tokenId: string; client: string; seen?: Seen };

const BURST_MESSAGES = 30;
const BURST_WINDOW_SECONDS = 300;

// Many messages in a few minutes is what a stolen token sending spam looks like.
async function countBurst(ctx: AgentContext): Promise<void> {
  const key = `burst:${ctx.agent.id}`;
  const sent = await bestEffort(async () => {
    const total = await redis.incr(key);
    if (total === 1) await redis.expire(key, BURST_WINDOW_SECONDS);
    return total;
  }, 0);
  if (sent !== BURST_MESSAGES) return;
  try {
    await raiseAlert({
      agent: ctx.agent,
      kind: "burst",
      tokenId: ctx.tokenId,
      details: {
        client: ctx.client,
        messages: BURST_MESSAGES,
        minutes: BURST_WINDOW_SECONDS / 60,
      },
    });
  } catch (err) {
    logger.warn({ err, agentId: ctx.agent.id }, "couldn't raise a burst alert");
  }
}

export async function agentSendMessage(
  ctx: AgentContext,
  input: Parameters<typeof sendMessage>[1],
): Promise<Awaited<ReturnType<typeof sendMessage>> | Held> {
  const held = await maybeHold(ctx, {
    kind: "message",
    input: {
      to: input.to,
      body: input.body,
      ...(input.idempotencyKey && { idempotencyKey: input.idempotencyKey }),
      ...(input.attachments?.length && { attachments: input.attachments }),
    },
  });
  if (held) return held;
  const sent = await sendMessage(ctx.agent, input);
  await countBurst(ctx);
  return sent;
}

export async function agentCreateGroup(
  ctx: AgentContext,
  input: Parameters<typeof createGroup>[1],
): Promise<Awaited<ReturnType<typeof createGroup>> | Held> {
  const held = await maybeHold(ctx, {
    kind: "group.create",
    input: { name: input.name, members: input.members, ...(input.note && { note: input.note }) },
  });
  return held ?? createGroup(ctx.agent, input);
}

export async function agentInviteToGroup(
  ctx: AgentContext,
  group: string,
  input: Parameters<typeof inviteToGroup>[2],
): Promise<Awaited<ReturnType<typeof inviteToGroup>> | Held> {
  const held = await maybeHold(ctx, {
    kind: "group.invite",
    input: { group, handles: input.handles, ...(input.note && { note: input.note }) },
  });
  return held ?? inviteToGroup(ctx.agent, group, input);
}

export async function agentInvitePerson(
  ctx: AgentContext,
  input: Parameters<typeof invitePerson>[1],
): Promise<Awaited<ReturnType<typeof invitePerson>> | Held> {
  const held = await maybeHold(ctx, {
    kind: "invite_person",
    input: { email: input.email, ...(input.note && { note: input.note }) },
  });
  return held ?? invitePerson(ctx.agent, input);
}
