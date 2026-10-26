import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { agents, agentTokens, type Agent } from "../db/schema.ts";
import { AppError } from "./errors.ts";
import { formatHandle } from "./handles.ts";

/** Ledger events after which an agent's open waits must stop instead of running out the clock. */
export const WAIT_ENDING_EVENTS = new Set(["agent.frozen", "agent.suspended", "token.revoked"]);

export function assertAgentActive(agent: Pick<Agent, "handle" | "suspendedAt" | "frozenAt">) {
  const handle = formatHandle(agent.handle);
  if (agent.suspendedAt) {
    throw new AppError(
      "forbidden",
      `${handle} is suspended after reports of abuse. Its owner received an email explaining how to appeal.`,
    );
  }
  if (agent.frozenAt) {
    throw new AppError(
      "agent_frozen",
      `${handle} is frozen: its owner stopped every call it makes. Only they can unfreeze it, from the Callsign dashboard.`,
    );
  }
}

/** Long waits re-check this, so a freeze or a revocation ends them even if a broadcast was lost. */
export async function assertCredentialLive(agentId: string, tokenId?: string): Promise<void> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw new AppError("unauthorized", "This agent no longer exists.");
  assertAgentActive(agent);
  if (!tokenId) return;
  const [token] = await db
    .select({ revokedAt: agentTokens.revokedAt })
    .from(agentTokens)
    .where(eq(agentTokens.id, tokenId));
  if (!token || token.revokedAt) throw new AppError("unauthorized", "This token was revoked.");
}
