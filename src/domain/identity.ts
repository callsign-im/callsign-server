import { and, count, eq, inArray, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/client.ts";
import { agents, contacts, owners, type Agent } from "../db/schema.ts";

const PERSONAL_EMAIL_DOMAINS = new Set([
  "aol.com",
  "att.net",
  "comcast.net",
  "duck.com",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.es",
  "hotmail.fr",
  "icloud.com",
  "live.com",
  "live.com.ar",
  "mac.com",
  "mail.com",
  "mail.ru",
  "me.com",
  "msn.com",
  "naver.com",
  "outlook.com",
  "outlook.es",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "163.com",
  "126.com",
  "rocketmail.com",
  "tutanota.com",
  "tuta.io",
  "web.de",
  "yahoo.com",
  "yahoo.com.ar",
  "yahoo.co.uk",
  "yahoo.es",
  "yandex.com",
  "yandex.ru",
  "ymail.com",
  "zoho.com",
]);

export function organizationDomain(email: string): string | null {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return domain && !PERSONAL_EMAIL_DOMAINS.has(domain) ? domain : null;
}

export type OwnerSignals = {
  verifiedDomain: string | null;
  sameOrganization: boolean;
  since: string;
  agents: number;
  mutualContacts: number;
};

// Signed-in owners proved access to their email, so its domain is a verified (but hideable) identity hint.
export async function ownerSignals(
  viewer: Agent,
  others: Agent[],
): Promise<Map<string, OwnerSignals>> {
  const ownerIds = [...new Set(others.map((agent) => agent.ownerId))];
  if (ownerIds.length === 0) return new Map();

  const theirs = alias(contacts, "their_contacts");
  const [ownerRows, agentCounts, mutualCounts] = await Promise.all([
    db
      .select({
        id: owners.id,
        email: owners.email,
        showDomain: owners.showDomain,
        createdAt: owners.createdAt,
      })
      .from(owners)
      .where(inArray(owners.id, [viewer.ownerId, ...ownerIds])),
    db
      .select({ ownerId: agents.ownerId, total: count() })
      .from(agents)
      .where(inArray(agents.ownerId, ownerIds))
      .groupBy(agents.ownerId),
    db
      .select({ ownerId: theirs.ownerId, total: count() })
      .from(contacts)
      .innerJoin(theirs, eq(theirs.agentId, contacts.agentId))
      .where(
        and(
          eq(contacts.ownerId, viewer.ownerId),
          inArray(theirs.ownerId, ownerIds),
          ne(theirs.ownerId, viewer.ownerId),
        ),
      )
      .groupBy(theirs.ownerId),
  ]);

  const byId = new Map(ownerRows.map((owner) => [owner.id, owner]));
  const viewerOrg = organizationDomain(byId.get(viewer.ownerId)?.email ?? "");
  const agentTotals = new Map(agentCounts.map((row) => [row.ownerId, row.total]));
  const mutualTotals = new Map(mutualCounts.map((row) => [row.ownerId, row.total]));

  const signals = new Map<string, OwnerSignals>();
  for (const agent of others) {
    const owner = byId.get(agent.ownerId);
    if (!owner) continue;
    const org = organizationDomain(owner.email);
    signals.set(agent.id, {
      verifiedDomain: owner.showDomain ? org : null,
      sameOrganization: org !== null && org === viewerOrg,
      since: owner.createdAt.toISOString(),
      agents: agentTotals.get(owner.id) ?? 0,
      mutualContacts: mutualTotals.get(owner.id) ?? 0,
    });
  }
  return signals;
}

export async function signalsFor(viewer: Agent, agent: Agent): Promise<OwnerSignals | null> {
  return (await ownerSignals(viewer, [agent])).get(agent.id) ?? null;
}
