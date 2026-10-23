import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import { agents, invitations, owners, type Agent, type Owner } from "../db/schema.ts";
import { enqueue } from "../jobs/queue.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import { uuidv7 } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { publicProfile } from "./agents.ts";
import { contactsByAgent, saveContact } from "./contacts.ts";
import { AppError } from "./errors.ts";
import { formatHandle } from "./handles.ts";
import { organizationDomain } from "./identity.ts";
import { ownerKey } from "./keys.ts";
import { appendLedgerEvent, broadcast } from "./ledger.ts";
import { sendMessage } from "./messaging.ts";
import { normalizeEmail } from "./owners.ts";
import { maskEmail } from "./registrations.ts";

const INVITATION_TTL_MS = 30 * 86_400_000;
const MAX_NOTE_LENGTH = 1000;

const noteContext = (id: string) => `invitations.note:${id}`;
const emailHash = (email: string) => sha256(`invitation:${email}`);

export async function invitePerson(
  inviter: Agent,
  input: { email: string; note?: string | undefined },
): Promise<{ sentTo: string; expiresAt: string }> {
  const email = normalizeEmail(input.email);
  const note = input.note?.trim().slice(0, MAX_NOTE_LENGTH) || null;
  await rateLimit(`invite:${inviter.id}`, 10, 86_400);
  await rateLimit(`invite-email:${emailHash(email)}`, 3, 7 * 86_400);

  const [inviterOwner] = await db.select().from(owners).where(eq(owners.id, inviter.ownerId));
  if (!inviterOwner) throw new AppError("not_found", "Account not found.");
  if (inviterOwner.email === email) {
    throw new AppError("invalid_input", "That's your owner's own email address.");
  }
  const [existing] = await db.select().from(owners).where(eq(owners.email, email));

  const id = uuidv7();
  const token = randomToken();
  const key = await ownerKey(inviter.ownerId);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const recorded = await db.transaction(async (tx) => {
    await tx.insert(invitations).values({
      id,
      inviterId: inviter.id,
      emailHash: emailHash(email),
      tokenHash: sha256(token),
      note: key.seal(note, noteContext(id)),
      expiresAt,
      ...(existing && { acceptedOwnerId: existing.id, acceptedAt: new Date() }),
    });
    const url = new URL(existing ? "/dashboard" : "/login", config.APP_URL);
    if (!existing) url.searchParams.set("invite", token);
    await enqueue(tx, "email.invitation", {
      email,
      from: formatHandle(inviter.handle),
      fromName: inviter.displayName,
      domain: inviterOwner.showDomain ? organizationDomain(inviterOwner.email) : null,
      note,
      url: url.toString(),
      existing: existing !== undefined,
    });
    return appendLedgerEvent(tx, inviter, {
      type: "invitation.sent",
      actor: "agent",
      data: { to: maskEmail(email) },
    });
  });
  await broadcast([recorded]);

  if (existing) await connectInvitee(existing);
  return { sentTo: maskEmail(email), expiresAt: expiresAt.toISOString() };
}

export async function invitationPreview(token: string) {
  const [row] = await db
    .select({ invitation: invitations, inviter: agents })
    .from(invitations)
    .innerJoin(agents, eq(agents.id, invitations.inviterId))
    .where(and(eq(invitations.tokenHash, sha256(token)), gt(invitations.expiresAt, new Date())));
  if (!row) throw new AppError("not_found", "This invitation expired or doesn't exist.");
  const key = await ownerKey(row.inviter.ownerId);
  return {
    from: publicProfile(row.inviter),
    note: key.open(row.invitation.note, noteContext(row.invitation.id)),
    expiresAt: row.invitation.expiresAt.toISOString(),
  };
}

// Runs when someone signs up: open invitations sent to their email now count as accepted.
export async function acceptInvitations(owner: Owner): Promise<void> {
  const accepted = await db
    .update(invitations)
    .set({ acceptedOwnerId: owner.id, acceptedAt: new Date() })
    .where(
      and(
        eq(invitations.emailHash, emailHash(owner.email)),
        isNull(invitations.acceptedOwnerId),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .returning({ id: invitations.id });
  if (accepted.length > 0) await connectInvitee(owner);
}

// Puts each inviter in the invitee's contacts and, once the invitee has an agent, delivers the
// invitation note as the first message of a conversation that needs no request.
export async function connectInvitee(owner: Owner): Promise<void> {
  const rows = await db
    .select({ invitation: invitations, inviter: agents })
    .from(invitations)
    .innerJoin(agents, eq(agents.id, invitations.inviterId))
    .where(and(eq(invitations.acceptedOwnerId, owner.id), isNull(invitations.deliveredAt)));
  if (rows.length === 0) return;

  const owned = await db
    .select()
    .from(agents)
    .where(eq(agents.ownerId, owner.id))
    .orderBy(asc(agents.createdAt));
  const recipient = owned.find((agent) => agent.primary) ?? owned[0];
  const known = await contactsByAgent(
    owner.id,
    rows.map((row) => row.inviter.id),
  );

  for (const { invitation, inviter } of rows) {
    if (!known.has(inviter.id)) {
      await saveContact(owner.id, { handle: inviter.handle, name: inviter.displayName });
    }
    if (!recipient) continue;
    try {
      const key = await ownerKey(inviter.ownerId);
      const note = key.open(invitation.note, noteContext(invitation.id));
      if (note) await sendMessage(inviter, { to: recipient.handle, body: note });
      const recorded = await db.transaction(async (tx) => {
        await tx
          .update(invitations)
          .set({ deliveredAt: new Date() })
          .where(eq(invitations.id, invitation.id));
        return appendLedgerEvent(tx, inviter, {
          type: "invitation.accepted",
          actor: "peer",
          data: { agent: formatHandle(recipient.handle) },
        });
      });
      await broadcast([recorded]);
    } catch (err) {
      logger.warn({ err, invitationId: invitation.id }, "couldn't deliver invitation note");
    }
  }
}

export async function connectInvitations(agent: Agent): Promise<void> {
  const [owner] = await db.select().from(owners).where(eq(owners.id, agent.ownerId));
  const [pending] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.acceptedOwnerId, agent.ownerId),
        isNotNull(invitations.acceptedAt),
        isNull(invitations.deliveredAt),
      ),
    )
    .limit(1);
  if (owner && pending) await connectInvitee(owner);
}
