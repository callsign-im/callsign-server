import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.ts";
import { db, type Executor, type Tx } from "../db/client.ts";
import { loginTokens, owners, sessions, type Owner } from "../db/schema.ts";
import { enqueue } from "../jobs/queue.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { telegramEnabled } from "../lib/telegram.ts";
import { AppError } from "./errors.ts";
import { newOwnerKey } from "./keys.ts";

const LOGIN_TOKEN_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 86_400_000;

const emailSchema = z.email().max(254);

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) {
    throw new AppError("invalid_input", "Enter a valid email address.");
  }
  return email;
}

export async function requestLogin(rawEmail: string, ip: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  await rateLimit(`login-ip:${ip}`, 20, 900);
  await rateLimit(`login-email:${email}`, 5, 900);

  const token = randomToken();
  const url = new URL("/auth/verify", config.APP_URL);
  url.searchParams.set("token", token);

  await db.transaction(async (tx) => {
    await tx.insert(loginTokens).values({
      id: uuidv7(),
      email,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS),
    });
    await enqueue(tx, "email.login", { email, url: url.toString() });
  });
}

export async function verifyLogin(
  token: string,
): Promise<{ owner: Owner; created: boolean; sessionToken: string; expiresAt: Date }> {
  return db.transaction(async (tx) => {
    const [login] = await tx
      .update(loginTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(loginTokens.tokenHash, sha256(token)),
          isNull(loginTokens.consumedAt),
          gt(loginTokens.expiresAt, new Date()),
        ),
      )
      .returning({ email: loginTokens.email });
    if (!login) {
      throw new AppError("unauthorized", "This sign-in link is invalid or has expired.");
    }

    const existing = await findOwnerByEmail(tx, login.email);
    const owner = existing ?? (await upsertOwner(tx, login.email));
    return { owner, created: !existing, ...(await createSession(tx, owner.id)) };
  });
}

async function findOwnerByEmail(executor: Executor, email: string): Promise<Owner | undefined> {
  const [owner] = await executor.select().from(owners).where(eq(owners.email, email));
  return owner;
}

export async function upsertOwner(executor: Executor, email: string): Promise<Owner> {
  const existing = await findOwnerByEmail(executor, email);
  if (existing) return existing;
  const id = uuidv7();
  await executor
    .insert(owners)
    .values({ id, email, dataKey: await newOwnerKey(id) })
    .onConflictDoNothing({ target: owners.email });
  const owner = await findOwnerByEmail(executor, email);
  if (!owner) throw new Error("owner upsert returned no row");
  return owner;
}

export async function updateOwner(owner: Owner, fields: { showDomain?: boolean }): Promise<Owner> {
  if (fields.showDomain === undefined) return owner;
  const [updated] = await db
    .update(owners)
    .set({ showDomain: fields.showDomain })
    .where(eq(owners.id, owner.id))
    .returning();
  if (!updated) throw new AppError("not_found", "Account not found.");
  return updated;
}

export function ownerAccountView(owner: Owner) {
  return {
    id: owner.id,
    email: owner.email,
    showDomain: owner.showDomain,
    telegram: telegramEnabled() ? { linked: owner.telegramChatId !== null } : null,
  };
}

export async function lockOwner(tx: Tx, ownerId: string): Promise<void> {
  const [owner] = await tx
    .select({ id: owners.id })
    .from(owners)
    .where(eq(owners.id, ownerId))
    .for("update");
  if (!owner) throw new AppError("not_found", "Account not found.");
}

export async function createSession(
  executor: Executor,
  ownerId: string,
): Promise<{ sessionToken: string; expiresAt: Date }> {
  const sessionToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await executor.insert(sessions).values({
    id: uuidv7(),
    ownerId,
    tokenHash: sha256(sessionToken),
    expiresAt,
  });
  return { sessionToken, expiresAt };
}

export async function findOwnerBySession(token: string): Promise<Owner | null> {
  const [row] = await db
    .select({ owner: owners })
    .from(sessions)
    .innerJoin(owners, eq(owners.id, sessions.ownerId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())));
  return row?.owner ?? null;
}

export async function revokeSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

export async function pruneExpiredCredentials(): Promise<void> {
  const now = new Date();
  await db.delete(loginTokens).where(lt(loginTokens.expiresAt, now));
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}
