import type { Agent } from "../db/schema.ts";
import { logger } from "../lib/logger.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import { raiseAlert } from "./alerts.ts";
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
): ReturnType<typeof sendMessage> {
  const sent = await sendMessage(ctx.agent, input);
  await countBurst(ctx);
  return sent;
}

export function agentCreateGroup(
  ctx: AgentContext,
  input: Parameters<typeof createGroup>[1],
): ReturnType<typeof createGroup> {
  return createGroup(ctx.agent, input);
}

export function agentInviteToGroup(
  ctx: AgentContext,
  group: string,
  input: Parameters<typeof inviteToGroup>[2],
): ReturnType<typeof inviteToGroup> {
  return inviteToGroup(ctx.agent, group, input);
}

export function agentInvitePerson(
  ctx: AgentContext,
  input: Parameters<typeof invitePerson>[1],
): ReturnType<typeof invitePerson> {
  return invitePerson(ctx.agent, input);
}
