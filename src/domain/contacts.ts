import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { agents, contacts, owners, type Agent, type Contact } from "../db/schema.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { findAgentByHandle, publicProfile } from "./agents.ts";
import { AppError } from "./errors.ts";
import { checkHandleFormat, formatHandle, normalizeHandle } from "./handles.ts";
import { appendLedgerEvent, broadcast } from "./ledger.ts";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_MATCHES = 10;

export type ContactFields = {
  name?: string | undefined;
  notes?: string | null | undefined;
  rules?: string | null | undefined;
};

export function contactView(contact: Contact, agent: Agent) {
  return {
    id: contact.id,
    name: contact.name,
    notes: contact.notes,
    rules: contact.rules,
    agent: publicProfile(agent),
  };
}

export async function listContacts(ownerId: string) {
  const rows = await db
    .select({ contact: contacts, agent: agents })
    .from(contacts)
    .innerJoin(agents, eq(agents.id, contacts.agentId))
    .where(eq(contacts.ownerId, ownerId))
    .orderBy(sql`lower(${contacts.name})`);
  return rows.map(({ contact, agent }) => contactView(contact, agent));
}

export async function contactsByAgent(
  ownerId: string,
  agentIds: string[],
): Promise<Map<string, Contact>> {
  if (agentIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.ownerId, ownerId), inArray(contacts.agentId, agentIds)));
  return new Map(rows.map((row) => [row.agentId, row]));
}

export async function saveContact(
  ownerId: string,
  input: { handle: string } & ContactFields,
  savedBy?: Agent,
) {
  const target = await findAgentByHandle(input.handle);
  if (!target) {
    throw new AppError(
      "not_found",
      `No agent is registered as ${formatHandle(normalizeHandle(input.handle))}.`,
    );
  }
  if (target.id === savedBy?.id) {
    throw new AppError("invalid_input", "An agent can't save itself as a contact.");
  }
  const name = input.name?.trim() || target.displayName;
  const fields = {
    name,
    ...(input.notes !== undefined && { notes: input.notes?.trim() || null }),
    ...(input.rules !== undefined && { rules: input.rules?.trim() || null }),
  };

  const { contact, recorded } = await db.transaction(async (tx) => {
    const [contact] = await tx
      .insert(contacts)
      .values({ id: uuidv7(), ownerId, agentId: target.id, ...fields })
      .onConflictDoUpdate({
        target: [contacts.ownerId, contacts.agentId],
        set: { ...fields, updatedAt: new Date() },
      })
      .returning();
    if (!contact) throw new Error("contact upsert returned no row");
    const recorded = savedBy
      ? [
          await appendLedgerEvent(tx, savedBy, {
            type: "contact.saved",
            actor: "agent",
            data: { handle: formatHandle(target.handle), name },
          }),
        ]
      : [];
    return { contact, recorded };
  });
  await broadcast(recorded);
  return contactView(contact, target);
}

export async function updateContact(ownerId: string, id: string, fields: ContactFields) {
  const patch = {
    ...(fields.name !== undefined && { name: fields.name.trim() }),
    ...(fields.notes !== undefined && { notes: fields.notes?.trim() || null }),
    ...(fields.rules !== undefined && { rules: fields.rules?.trim() || null }),
  };
  const [contact] = await db
    .update(contacts)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(contacts.id, id), eq(contacts.ownerId, ownerId)))
    .returning();
  if (!contact) throw new AppError("not_found", "Contact not found.");
  const [agent] = await db.select().from(agents).where(eq(agents.id, contact.agentId));
  if (!agent) throw new Error(`contact ${contact.id} points to a missing agent`);
  return contactView(contact, agent);
}

export async function deleteContact(ownerId: string, id: string): Promise<void> {
  const [deleted] = await db
    .delete(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.ownerId, ownerId)))
    .returning({ id: contacts.id });
  if (!deleted) throw new AppError("not_found", "Contact not found.");
}

export type AgentMatch = ReturnType<typeof publicProfile> & {
  matchedBy: "handle" | "email" | "contact";
  contact: string | null;
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function findAgents(me: Agent, rawQuery: string): Promise<AgentMatch[]> {
  const query = rawQuery.trim();
  if (!query) throw new AppError("invalid_input", "Tell me who to look for.");
  const found = new Map<string, { agent: Agent; matchedBy: AgentMatch["matchedBy"] }>();

  if (EMAIL.test(query) && !query.startsWith("@")) {
    await rateLimit(`find-email:${me.id}`, 30, 3600);
    const rows = await db
      .select({ agent: agents })
      .from(agents)
      .innerJoin(owners, eq(owners.id, agents.ownerId))
      .where(and(eq(owners.email, query.toLowerCase()), eq(agents.discoverable, true)))
      .limit(MAX_MATCHES);
    for (const { agent } of rows) found.set(agent.id, { agent, matchedBy: "email" });
  } else {
    const handle = normalizeHandle(query);
    if (checkHandleFormat(handle) !== "invalid") {
      const agent = await findAgentByHandle(handle);
      if (agent) found.set(agent.id, { agent, matchedBy: "handle" });
    }
    const rows = await db
      .select({ agent: agents })
      .from(contacts)
      .innerJoin(agents, eq(agents.id, contacts.agentId))
      .where(
        and(
          eq(contacts.ownerId, me.ownerId),
          ilike(contacts.name, `%${escapeLike(query.replace(/^@/, ""))}%`),
        ),
      )
      .limit(MAX_MATCHES);
    for (const { agent } of rows) {
      if (!found.has(agent.id)) found.set(agent.id, { agent, matchedBy: "contact" });
    }
  }

  found.delete(me.id);
  const names = await contactsByAgent(me.ownerId, [...found.keys()]);
  return [...found.values()].slice(0, MAX_MATCHES).map(({ agent, matchedBy }) => ({
    ...publicProfile(agent),
    matchedBy,
    contact: names.get(agent.id)?.name ?? null,
  }));
}
