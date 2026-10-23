import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.ts";
import { agents, contacts, owners, type Agent, type Contact } from "../db/schema.ts";
import type { DataKey } from "../lib/encryption.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { findAgentByHandle, publicProfile } from "./agents.ts";
import { AppError } from "./errors.ts";
import { checkHandleFormat, formatHandle, normalizeHandle } from "./handles.ts";
import { ownerKey } from "./keys.ts";
import { appendLedgerEvent, broadcast } from "./ledger.ts";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_MATCHES = 10;

const byName = new Intl.Collator(undefined, { sensitivity: "base" });

export type ContactFields = {
  name?: string | undefined;
  notes?: string | null | undefined;
  rules?: string | null | undefined;
};

export type ContactRecord = Omit<Contact, "name" | "notes" | "rules"> & {
  name: string;
  notes: string | null;
  rules: string | null;
};

const fieldContext = (agentId: string, field: "name" | "notes" | "rules") =>
  `contacts.${field}:${agentId}`;

function openContact(key: DataKey, contact: Contact): ContactRecord {
  return {
    ...contact,
    name: key.open(contact.name, fieldContext(contact.agentId, "name")),
    notes: key.open(contact.notes, fieldContext(contact.agentId, "notes")),
    rules: key.open(contact.rules, fieldContext(contact.agentId, "rules")),
  };
}

function sealFields(key: DataKey, agentId: string, fields: ContactFields) {
  return {
    ...(fields.name !== undefined && {
      name: key.seal(fields.name.trim(), fieldContext(agentId, "name")),
    }),
    ...(fields.notes !== undefined && {
      notes: key.seal(fields.notes?.trim() || null, fieldContext(agentId, "notes")),
    }),
    ...(fields.rules !== undefined && {
      rules: key.seal(fields.rules?.trim() || null, fieldContext(agentId, "rules")),
    }),
  };
}

export function contactView(contact: ContactRecord, agent: Agent) {
  return {
    id: contact.id,
    name: contact.name,
    notes: contact.notes,
    rules: contact.rules,
    agent: publicProfile(agent),
  };
}

async function savedContacts(ownerId: string) {
  const key = await ownerKey(ownerId);
  const rows = await db
    .select({ contact: contacts, agent: agents })
    .from(contacts)
    .innerJoin(agents, eq(agents.id, contacts.agentId))
    .where(eq(contacts.ownerId, ownerId));
  return rows
    .map(({ contact, agent }) => ({ contact: openContact(key, contact), agent }))
    .sort((a, b) => byName.compare(a.contact.name, b.contact.name));
}

export async function listContacts(ownerId: string) {
  const saved = await savedContacts(ownerId);
  return saved.map(({ contact, agent }) => contactView(contact, agent));
}

export async function contactsByAgent(
  ownerId: string,
  agentIds: string[],
): Promise<Map<string, ContactRecord>> {
  if (agentIds.length === 0) return new Map();
  const key = await ownerKey(ownerId);
  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.ownerId, ownerId), inArray(contacts.agentId, agentIds)));
  return new Map(rows.map((row) => [row.agentId, openContact(key, row)]));
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
  const key = await ownerKey(ownerId);
  const fields = {
    ...sealFields(key, target.id, { notes: input.notes, rules: input.rules }),
    name: key.seal(name, fieldContext(target.id, "name")),
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
  return contactView(openContact(key, contact), target);
}

export async function updateContact(ownerId: string, id: string, fields: ContactFields) {
  const [current] = await db
    .select({ contact: contacts, agent: agents })
    .from(contacts)
    .innerJoin(agents, eq(agents.id, contacts.agentId))
    .where(and(eq(contacts.id, id), eq(contacts.ownerId, ownerId)));
  if (!current) throw new AppError("not_found", "Contact not found.");
  const key = await ownerKey(ownerId);
  const [contact] = await db
    .update(contacts)
    .set({ ...sealFields(key, current.contact.agentId, fields), updatedAt: new Date() })
    .where(eq(contacts.id, id))
    .returning();
  if (!contact) throw new AppError("not_found", "Contact not found.");
  return contactView(openContact(key, contact), current.agent);
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

export async function findAgents(me: Agent, rawQuery: string): Promise<AgentMatch[]> {
  const query = rawQuery.trim();
  if (!query) throw new AppError("invalid_input", "Tell me who to look for.");
  const saved = await savedContacts(me.ownerId);
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
    const needle = query.replace(/^@/, "").toLowerCase();
    for (const { contact, agent } of saved) {
      if (!found.has(agent.id) && contact.name.toLowerCase().includes(needle)) {
        found.set(agent.id, { agent, matchedBy: "contact" });
      }
    }
  }

  found.delete(me.id);
  const names = new Map(saved.map(({ contact }) => [contact.agentId, contact.name]));
  return [...found.values()].slice(0, MAX_MATCHES).map(({ agent, matchedBy }) => ({
    ...publicProfile(agent),
    matchedBy,
    contact: names.get(agent.id) ?? null,
  }));
}
