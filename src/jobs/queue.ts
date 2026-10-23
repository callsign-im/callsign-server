import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client.ts";
import { jobs, type Job } from "../db/schema.ts";
import { uuidv7 } from "../lib/ids.ts";

export type AgentNotification = {
  agentId: string;
  conversationId: string;
  seq: number;
  kind: "request" | "message";
};

export type JobPayloads = {
  "email.login": { email: string; url: string };
  "agent.webhook": AgentNotification;
  "agent.email": AgentNotification;
};

export type JobKind = keyof JobPayloads;

export async function enqueue<K extends JobKind>(
  executor: Executor,
  kind: K,
  payload: JobPayloads[K],
): Promise<void> {
  await executor.insert(jobs).values({ id: uuidv7(), kind, payload });
}

const LOCK_SECONDS = 300;

export async function claimJobs(limit: number): Promise<Job[]> {
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        isNull(jobs.completedAt),
        isNull(jobs.failedAt),
        lte(jobs.runAt, sql`now()`),
        or(isNull(jobs.lockedUntil), lt(jobs.lockedUntil, sql`now()`)),
      ),
    )
    .orderBy(jobs.runAt)
    .limit(limit)
    .for("update", { skipLocked: true });

  return db
    .update(jobs)
    .set({
      attempts: sql`${jobs.attempts} + 1`,
      lockedUntil: sql`now() + make_interval(secs => ${LOCK_SECONDS})`,
    })
    .where(inArray(jobs.id, due))
    .returning();
}

export async function completeJob(job: Job): Promise<void> {
  await db
    .update(jobs)
    .set({ completedAt: new Date(), lockedUntil: null })
    .where(eq(jobs.id, job.id));
}

export async function failJob(job: Job, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  const delaySeconds = Math.min(5 * 2 ** job.attempts, 3600);
  await db
    .update(jobs)
    .set({
      lastError: message.slice(0, 2000),
      lockedUntil: null,
      ...(exhausted
        ? { failedAt: new Date() }
        : { runAt: new Date(Date.now() + delaySeconds * 1000) }),
    })
    .where(eq(jobs.id, job.id));
}

export async function pruneFinishedJobs(olderThanDays: number): Promise<void> {
  await db
    .delete(jobs)
    .where(
      and(
        or(isNotNull(jobs.completedAt), isNotNull(jobs.failedAt)),
        lt(jobs.createdAt, new Date(Date.now() - olderThanDays * 86_400_000)),
      ),
    );
}
