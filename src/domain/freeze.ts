import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  agents,
  eventSubscriptions,
  securityAlerts,
  type Agent,
  type Owner,
} from "../db/schema.ts";
import { revokeTokensInTx } from "./agents.ts";
import { AppError } from "./errors.ts";
import { formatHandle } from "./handles.ts";
import { appendLedgerEvent, broadcast, type Actor } from "./ledger.ts";
import { createNotice } from "./notices.ts";
import type { OwnerSession } from "./owners.ts";
import { assertStepUp } from "./passkeys.ts";

export type FreezeVia = "dashboard" | "email" | "telegram";

/**
 * Freezing is always one tap: it only stops things, so no passkey is needed. The agent keeps
 * receiving messages, but every call it makes is refused and nothing wakes it.
 */
export async function freezeAgent(
  agent: Agent,
  options: { actor: Actor; via: FreezeVia; alertId?: string },
): Promise<Agent> {
  const frozen = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(agents)
      .set({ frozenAt: new Date() })
      .where(and(eq(agents.id, agent.id), isNull(agents.frozenAt)))
      .returning();
    if (!row) return null;
    await tx.delete(eventSubscriptions).where(eq(eventSubscriptions.agentId, agent.id));
    const recorded = await appendLedgerEvent(tx, row, {
      type: "agent.frozen",
      actor: options.actor,
      data: { via: options.via, ...(options.alertId && { alertId: options.alertId }) },
    });
    return { row, recorded };
  });
  if (!frozen) {
    const [current] = await db.select().from(agents).where(eq(agents.id, agent.id));
    return current ?? agent;
  }
  await broadcast([frozen.recorded]);
  return frozen.row;
}

export async function unfreezeAgent(
  owner: Owner,
  session: OwnerSession,
  agent: Agent,
  options: { revokeTokens: boolean },
): Promise<{ agent: Agent; revokedTokens: number }> {
  await assertStepUp(owner.id, session);
  const handle = formatHandle(agent.handle);
  const { row, recorded, revoked } = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(agents)
      .set({ frozenAt: null })
      .where(and(eq(agents.id, agent.id), isNotNull(agents.frozenAt)))
      .returning();
    if (!row) throw new AppError("conflict", `${handle} isn't frozen.`);
    const revoked = options.revokeTokens
      ? await revokeTokensInTx(tx, row, "all", "owner", "unfreeze")
      : [];
    const unfrozen = await appendLedgerEvent(tx, row, {
      type: "agent.unfrozen",
      actor: "owner",
      data: { revokedTokens: revoked.length },
    });
    await tx
      .update(securityAlerts)
      .set({ status: "resolved", resolvedVia: "unfreeze", resolvedAt: new Date() })
      .where(and(eq(securityAlerts.agentId, agent.id), eq(securityAlerts.status, "frozen")));
    const notice = await createNotice(tx, row, {
      kind: "agent.unfrozen",
      actor: null,
      actorKind: "owner",
      conversationId: null,
      planId: null,
      taskKey: null,
      text: options.revokeTokens
        ? `Your owner unfroze ${handle} and disconnected its old connections. Calls refused while it was frozen didn't happen; redo the ones that still matter.`
        : `Your owner unfroze ${handle}. Calls refused while it was frozen didn't happen; redo the ones that still matter.`,
    });
    return { row, recorded: [...revoked, unfrozen, notice], revoked: revoked.length };
  });
  await broadcast(recorded);
  return { agent: row, revokedTokens: revoked };
}
