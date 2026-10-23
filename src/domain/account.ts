import { asc, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "../db/client.ts";
import {
  agentRegistrations,
  agentTokens,
  agents,
  contacts,
  conversationMembers,
  conversations,
  jobs,
  ledgerEvents,
  loginTokens,
  messages,
  owners,
  type Agent,
  type Owner,
} from "../db/schema.ts";
import { agentRules, listOwnerAgents, publicProfile } from "./agents.ts";
import { listContacts } from "./contacts.ts";
import { appendLedgerEvent, broadcast, exportLedger, type RecordedEvent } from "./ledger.ts";
import { exportConversations, forgetInbox } from "./messaging.ts";
import { lockOwner } from "./owners.ts";

async function eraseAgent(tx: Tx, agent: Agent): Promise<void> {
  const memberships = await tx
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(eq(conversationMembers.agentId, agent.id));
  const conversationIds = memberships.map((m) => m.conversationId);
  if (conversationIds.length > 0) {
    await tx.delete(messages).where(inArray(messages.conversationId, conversationIds));
    await tx
      .delete(conversationMembers)
      .where(inArray(conversationMembers.conversationId, conversationIds));
    await tx.delete(conversations).where(inArray(conversations.id, conversationIds));
  }
  await tx.delete(contacts).where(eq(contacts.agentId, agent.id));
  await tx.delete(agentTokens).where(eq(agentTokens.agentId, agent.id));
  await tx.execute(sql`select set_config('callsign.erasing_agent', ${agent.id}, true)`);
  await tx.delete(ledgerEvents).where(eq(ledgerEvents.agentId, agent.id));
  await tx.delete(agents).where(eq(agents.id, agent.id));
}

async function ensurePrimaryAgent(tx: Tx, ownerId: string): Promise<RecordedEvent[]> {
  const owned = await tx
    .select()
    .from(agents)
    .where(eq(agents.ownerId, ownerId))
    .orderBy(asc(agents.createdAt), asc(agents.id));
  const [oldest] = owned;
  if (!oldest || owned.some((agent) => agent.primary)) return [];
  await tx.update(agents).set({ primary: true }).where(eq(agents.id, oldest.id));
  return [
    await appendLedgerEvent(tx, oldest, {
      type: "agent.updated",
      actor: "owner",
      data: { fields: ["primary"] },
    }),
  ];
}

export async function deleteAgent(agent: Agent): Promise<void> {
  const recorded = await db.transaction(async (tx) => {
    await lockOwner(tx, agent.ownerId);
    await eraseAgent(tx, agent);
    return ensurePrimaryAgent(tx, agent.ownerId);
  });
  await forgetInbox(agent.id);
  await broadcast(recorded);
}

export async function deleteAccount(owner: Owner): Promise<void> {
  const erased = await db.transaction(async (tx) => {
    await lockOwner(tx, owner.id);
    const owned = await tx.select().from(agents).where(eq(agents.ownerId, owner.id));
    for (const agent of owned) await eraseAgent(tx, agent);
    await tx.delete(agentRegistrations).where(eq(agentRegistrations.ownerEmail, owner.email));
    await tx.delete(loginTokens).where(eq(loginTokens.email, owner.email));
    await tx.delete(jobs).where(sql`${jobs.payload}->>'email' = ${owner.email}`);
    await tx.delete(owners).where(eq(owners.id, owner.id));
    return owned;
  });
  await Promise.all(erased.map((agent) => forgetInbox(agent.id)));
}

export async function exportAccount(owner: Owner) {
  const owned = await listOwnerAgents(owner.id);
  return {
    exportedAt: new Date().toISOString(),
    owner: { email: owner.email, createdAt: owner.createdAt.toISOString() },
    contacts: await listContacts(owner.id),
    agents: await Promise.all(
      owned.map(async (agent) => ({
        ...publicProfile(agent),
        primary: agent.primary,
        discoverable: agent.discoverable,
        webhookUrl: agent.webhookUrl,
        notifyEmail: agent.notifyEmail,
        rules: await agentRules(agent),
        conversations: await exportConversations(agent),
        ledger: await exportLedger(agent),
      })),
    ),
  };
}
