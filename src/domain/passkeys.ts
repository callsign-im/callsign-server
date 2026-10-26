import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, count, eq, type SQL } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import { ownerPasskeys, owners, passkeyResets, sessions, type Owner } from "../db/schema.ts";
import { enqueue } from "../jobs/queue.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import { uuidv7 } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { redis } from "../lib/redis.ts";
import { tellOwnerOnTelegram } from "../lib/telegram.ts";
import { AppError } from "./errors.ts";
import type { OwnerSession } from "./owners.ts";

export const ELEVATION_MS = 5 * 60_000;
// The first passkey can only be added right after an email sign-in, so a stolen long-lived
// session cookie can't plant one and lock the real owner out.
const FRESH_LOGIN_MS = 15 * 60_000;
const CHALLENGE_SECONDS = 300;
export const RESET_DELAY_MS = 72 * 3_600_000;
const MAX_PASSKEYS = 10;

export const rpId = config.WEBAUTHN_RP_ID ?? new URL(config.APP_URL).hostname;
const origins = [new URL(config.APP_URL).origin, ...config.WEBAUTHN_EXTRA_ORIGINS];

const challengeKey = (sessionId: string, kind: "reg" | "auth") => `webauthn:${sessionId}:${kind}`;

export type PasskeyView = {
  id: string;
  name: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

function view(row: typeof ownerPasskeys.$inferSelect): PasskeyView {
  return {
    id: row.id,
    name: row.name,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

async function passkeyCount(ownerId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(ownerPasskeys)
    .where(eq(ownerPasskeys.ownerId, ownerId));
  return row?.total ?? 0;
}

export async function ownerHasPasskeys(ownerId: string): Promise<boolean> {
  return (await passkeyCount(ownerId)) > 0;
}

export function isElevated(session: OwnerSession): boolean {
  return session.elevatedUntil !== null && session.elevatedUntil.getTime() > Date.now();
}

/** Owners with a passkey confirm sensitive changes with it; owners without one aren't asked. */
export async function assertStepUp(ownerId: string, session: OwnerSession): Promise<void> {
  if (isElevated(session) || !(await ownerHasPasskeys(ownerId))) return;
  throw new AppError("step_up_required", "Confirm it's you with your passkey.");
}

export async function listPasskeys(ownerId: string): Promise<PasskeyView[]> {
  const rows = await db
    .select()
    .from(ownerPasskeys)
    .where(eq(ownerPasskeys.ownerId, ownerId))
    .orderBy(ownerPasskeys.createdAt);
  return rows.map(view);
}

async function assertMayAddPasskey(owner: Owner, session: OwnerSession): Promise<number> {
  const existing = await passkeyCount(owner.id);
  if (existing >= MAX_PASSKEYS) {
    throw new AppError("conflict", `You can register up to ${MAX_PASSKEYS} passkeys.`);
  }
  if (existing > 0) {
    await assertStepUp(owner.id, session);
  } else if (Date.now() - session.createdAt.getTime() > FRESH_LOGIN_MS) {
    throw new AppError(
      "forbidden",
      "To add your first passkey, sign out and sign in again with a fresh email link. It's how we know the request comes from you.",
      { reason: "fresh_login_required" },
    );
  }
  return existing;
}

export async function registrationOptions(
  owner: Owner,
  session: OwnerSession,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  await assertMayAddPasskey(owner, session);
  const existing = await db
    .select({ id: ownerPasskeys.credentialId, transports: ownerPasskeys.transports })
    .from(ownerPasskeys)
    .where(eq(ownerPasskeys.ownerId, owner.id));
  const options = await generateRegistrationOptions({
    rpName: config.WEBAUTHN_RP_NAME,
    rpID: rpId,
    userName: owner.email,
    userDisplayName: owner.email,
    userID: Uint8Array.from(Buffer.from(owner.id.replaceAll("-", ""), "hex")),
    attestationType: "none",
    excludeCredentials: existing.map((row) => ({ id: row.id, transports: row.transports ?? [] })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  await redis.set(challengeKey(session.id, "reg"), options.challenge, "EX", CHALLENGE_SECONDS);
  return options;
}

export async function registerPasskey(
  owner: Owner,
  session: OwnerSession,
  response: RegistrationResponseJSON,
  name: string | undefined,
): Promise<PasskeyView> {
  const challenge = await redis.getdel(challengeKey(session.id, "reg"));
  if (!challenge) throw new AppError("invalid_input", "That passkey request expired. Try again.");
  const existing = await assertMayAddPasskey(owner, session);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
  } catch (err) {
    logger.info({ err }, "passkey registration rejected");
    throw new AppError("invalid_input", "That passkey couldn't be verified. Try again.");
  }
  if (!verification.verified) {
    throw new AppError("invalid_input", "That passkey couldn't be verified. Try again.");
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const [row] = await db
    .insert(ownerPasskeys)
    .values({
      id: uuidv7(),
      ownerId: owner.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      name: name?.trim().slice(0, 60) || `Passkey ${existing + 1}`,
    })
    .returning();
  await enqueue(db, "email.passkey", { email: owner.email, change: "added", name: row!.name });
  return view(row!);
}

export async function renamePasskey(ownerId: string, id: string, name: string): Promise<void> {
  const updated = await db
    .update(ownerPasskeys)
    .set({ name: name.trim().slice(0, 60) })
    .where(and(eq(ownerPasskeys.id, id), eq(ownerPasskeys.ownerId, ownerId)))
    .returning({ id: ownerPasskeys.id });
  if (updated.length === 0) throw new AppError("not_found", "Passkey not found.");
}

export async function removePasskey(
  owner: Owner,
  session: OwnerSession,
  id: string,
): Promise<void> {
  await assertStepUp(owner.id, session);
  const [removed] = await db
    .delete(ownerPasskeys)
    .where(and(eq(ownerPasskeys.id, id), eq(ownerPasskeys.ownerId, owner.id)))
    .returning({ name: ownerPasskeys.name });
  if (!removed) throw new AppError("not_found", "Passkey not found.");
  await enqueue(db, "email.passkey", { email: owner.email, change: "removed", name: removed.name });
}

export async function stepUpOptions(
  owner: Owner,
  session: OwnerSession,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  await rateLimit(`step-up:${owner.id}`, 30, 3600);
  const passkeys = await db
    .select({ id: ownerPasskeys.credentialId, transports: ownerPasskeys.transports })
    .from(ownerPasskeys)
    .where(eq(ownerPasskeys.ownerId, owner.id));
  if (passkeys.length === 0) throw new AppError("conflict", "You don't have a passkey yet.");
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: passkeys.map((row) => ({ id: row.id, transports: row.transports ?? [] })),
    userVerification: "required",
  });
  await redis.set(challengeKey(session.id, "auth"), options.challenge, "EX", CHALLENGE_SECONDS);
  return options;
}

export async function verifyStepUp(
  owner: Owner,
  session: OwnerSession,
  response: AuthenticationResponseJSON,
): Promise<{ elevatedUntil: string }> {
  const challenge = await redis.getdel(challengeKey(session.id, "auth"));
  if (!challenge) throw new AppError("invalid_input", "That passkey check expired. Try again.");
  const [passkey] = await db
    .select()
    .from(ownerPasskeys)
    .where(and(eq(ownerPasskeys.credentialId, response.id), eq(ownerPasskeys.ownerId, owner.id)));
  if (!passkey) throw new AppError("unauthorized", "That passkey isn't registered to you.");

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: Uint8Array.from(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports ?? undefined,
      },
      requireUserVerification: true,
    });
  } catch (err) {
    // Includes a counter that went backwards, the sign of a cloned authenticator.
    logger.warn({ err, ownerId: owner.id }, "passkey step-up rejected");
    throw new AppError("unauthorized", "That passkey couldn't be verified.");
  }
  if (!verification.verified) {
    throw new AppError("unauthorized", "That passkey couldn't be verified.");
  }

  const elevatedUntil = new Date(Date.now() + ELEVATION_MS);
  await db.transaction(async (tx) => {
    await tx
      .update(ownerPasskeys)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(ownerPasskeys.id, passkey.id));
    await tx.update(sessions).set({ elevatedUntil }).where(eq(sessions.id, session.id));
  });
  return { elevatedUntil: elevatedUntil.toISOString() };
}

// ---- recovery --------------------------------------------------------------------------------

export type PasskeyResetView = { id: string; runAt: string; status: string } | null;

export async function pendingPasskeyReset(ownerId: string): Promise<PasskeyResetView> {
  const [row] = await db
    .select()
    .from(passkeyResets)
    .where(and(eq(passkeyResets.ownerId, ownerId), eq(passkeyResets.status, "pending")));
  return row ? { id: row.id, runAt: row.runAt.toISOString(), status: row.status } : null;
}

function cancelUrl(token: string): string {
  return new URL(`/passkey-reset?token=${token}`, config.APP_URL).toString();
}

/**
 * Lost every passkey: removing them takes 72 hours, during which the owner is told on every
 * channel and can cancel. Someone holding only the inbox can't do it quietly.
 */
export async function requestPasskeyReset(
  owner: Owner,
  session: OwnerSession,
): Promise<NonNullable<PasskeyResetView>> {
  if (!(await ownerHasPasskeys(owner.id))) {
    throw new AppError("conflict", "You don't have any passkeys to reset.");
  }
  if (Date.now() - session.createdAt.getTime() > FRESH_LOGIN_MS) {
    throw new AppError(
      "forbidden",
      "To reset your passkeys, sign out and sign in again with a fresh email link first.",
      { reason: "fresh_login_required" },
    );
  }
  const pending = await pendingPasskeyReset(owner.id);
  if (pending) return pending;

  const token = randomToken();
  const runAt = new Date(Date.now() + RESET_DELAY_MS);
  const id = uuidv7();
  await db.transaction(async (tx) => {
    await tx
      .insert(passkeyResets)
      .values({ id, ownerId: owner.id, cancelTokenHash: sha256(token), runAt });
    await enqueue(tx, "passkey.reset", { resetId: id }, { runAt });
    await enqueue(tx, "email.passkey", {
      email: owner.email,
      change: "reset_requested",
      runAt: runAt.toISOString(),
      cancelUrl: cancelUrl(token),
    });
  });
  await tellOwnerOnTelegram(
    owner,
    `Someone asked to remove every passkey from your Callsign account. It happens on ${runAt.toUTCString()} unless you cancel: ${cancelUrl(token)}`,
  );
  return { id, runAt: runAt.toISOString(), status: "pending" };
}

async function cancelReset(where: SQL, email: string): Promise<boolean> {
  const cancelled = await db
    .update(passkeyResets)
    .set({ status: "cancelled" })
    .where(and(where, eq(passkeyResets.status, "pending")))
    .returning({ id: passkeyResets.id });
  if (cancelled.length > 0) {
    await enqueue(db, "email.passkey", { email, change: "reset_cancelled" });
  }
  return cancelled.length > 0;
}

export async function cancelPasskeyReset(owner: Owner): Promise<void> {
  await cancelReset(eq(passkeyResets.ownerId, owner.id), owner.email);
}

/** Opening the cancel link only shows the request; cancelling takes a deliberate POST. */
export async function passkeyResetByLink(
  token: string,
): Promise<{ status: "pending" | "cancelled" | "done"; runAt: string }> {
  const [row] = await db
    .select({ status: passkeyResets.status, runAt: passkeyResets.runAt })
    .from(passkeyResets)
    .where(eq(passkeyResets.cancelTokenHash, sha256(token)));
  if (!row) throw new AppError("not_found", "This link isn't valid.");
  return { status: row.status, runAt: row.runAt.toISOString() };
}

export async function cancelPasskeyResetByLink(token: string): Promise<{ cancelled: boolean }> {
  const [row] = await db
    .select({ ownerId: passkeyResets.ownerId })
    .from(passkeyResets)
    .where(eq(passkeyResets.cancelTokenHash, sha256(token)));
  if (!row) throw new AppError("not_found", "This link isn't valid.");
  const [owner] = await db.select().from(owners).where(eq(owners.id, row.ownerId));
  const cancelled = await cancelReset(
    eq(passkeyResets.cancelTokenHash, sha256(token)),
    owner?.email ?? "",
  );
  return { cancelled };
}

export async function runPasskeyReset({ resetId }: { resetId: string }): Promise<void> {
  const done = await db.transaction(async (tx) => {
    const [reset] = await tx
      .update(passkeyResets)
      .set({ status: "done" })
      .where(and(eq(passkeyResets.id, resetId), eq(passkeyResets.status, "pending")))
      .returning();
    if (!reset) return null;
    if (reset.runAt.getTime() > Date.now()) {
      throw new Error("passkey reset ran before its time");
    }
    await tx.delete(ownerPasskeys).where(eq(ownerPasskeys.ownerId, reset.ownerId));
    await tx
      .update(sessions)
      .set({ elevatedUntil: null })
      .where(eq(sessions.ownerId, reset.ownerId));
    return reset;
  });
  if (!done) return;
  const [owner] = await db.select().from(owners).where(eq(owners.id, done.ownerId));
  if (owner) await enqueue(db, "email.passkey", { email: owner.email, change: "reset_done" });
}
