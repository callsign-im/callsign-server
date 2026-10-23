import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import { agents, ownerQuestions, owners, type Agent, type OwnerQuestion } from "../db/schema.ts";
import { enqueue } from "../jobs/queue.ts";
import type { DataKey } from "../lib/encryption.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { bumpInbox } from "./conversations.ts";
import { AppError } from "./errors.ts";
import { formatHandle } from "./handles.ts";
import { ownerKey } from "./keys.ts";
import { appendLedgerEvent, broadcast } from "./ledger.ts";

export const MAX_QUESTION_LENGTH = 2000;

export type OwnerAnswer = {
  questionId: string;
  question: string;
  answer: string;
  answeredAt: string;
};

const fieldContext = (id: string, field: "question" | "context" | "answer") =>
  `owner_questions.${field}:${id}`;

function openQuestion(key: DataKey, row: OwnerQuestion) {
  return {
    id: row.id,
    question: key.open(row.question, fieldContext(row.id, "question")),
    context: key.open(row.context, fieldContext(row.id, "context")),
    answer: key.open(row.answer, fieldContext(row.id, "answer")),
    askedAt: row.createdAt.toISOString(),
    answeredAt: row.answeredAt?.toISOString() ?? null,
  };
}

export async function askOwner(
  agent: Agent,
  input: { question: string; context?: string | undefined },
) {
  const question = input.question.trim();
  if (!question) throw new AppError("invalid_input", "Write the question for your owner.");
  await rateLimit(`ask-owner:${agent.id}`, 20, 3600);
  const id = uuidv7();
  const key = await ownerKey(agent.ownerId);
  const [owner] = await db.select().from(owners).where(eq(owners.id, agent.ownerId));
  if (!owner) throw new AppError("not_found", "Account not found.");

  const { row, recorded } = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(ownerQuestions)
      .values({
        id,
        agentId: agent.id,
        question: key.seal(question, fieldContext(id, "question")),
        context: key.seal(input.context?.trim() || null, fieldContext(id, "context")),
      })
      .returning();
    if (!row) throw new Error("question insert returned no row");
    await enqueue(tx, "email.question", {
      email: owner.email,
      handle: formatHandle(agent.handle),
      question,
      url: new URL(`/dashboard?question=${id}`, config.APP_URL).toString(),
    });
    const recorded = await appendLedgerEvent(tx, agent, {
      type: "owner.asked",
      actor: "agent",
      data: { questionId: id, question },
    });
    return { row, recorded };
  });
  await broadcast([recorded]);
  return openQuestion(key, row);
}

export async function questionStatus(agent: Agent, id: string) {
  const [row] = await db
    .select()
    .from(ownerQuestions)
    .where(and(eq(ownerQuestions.id, id), eq(ownerQuestions.agentId, agent.id)));
  if (!row) throw new AppError("not_found", "Question not found.");
  return openQuestion(await ownerKey(agent.ownerId), row);
}

export async function listOwnerQuestions(ownerId: string, options: { open: boolean }) {
  const rows = await db
    .select({ question: ownerQuestions, handle: agents.handle })
    .from(ownerQuestions)
    .innerJoin(agents, eq(agents.id, ownerQuestions.agentId))
    .where(
      and(
        eq(agents.ownerId, ownerId),
        options.open ? isNull(ownerQuestions.answeredAt) : isNotNull(ownerQuestions.answeredAt),
      ),
    )
    .orderBy(desc(ownerQuestions.createdAt))
    .limit(50);
  const key = await ownerKey(ownerId);
  return rows.map(({ question, handle }) => ({
    ...openQuestion(key, question),
    agent: formatHandle(handle),
  }));
}

export async function answerQuestion(ownerId: string, id: string, answer: string) {
  const text = answer.trim();
  if (!text) throw new AppError("invalid_input", "Write an answer.");
  const [found] = await db
    .select({ question: ownerQuestions, agent: agents })
    .from(ownerQuestions)
    .innerJoin(agents, eq(agents.id, ownerQuestions.agentId))
    .where(and(eq(ownerQuestions.id, id), eq(agents.ownerId, ownerId)));
  if (!found) throw new AppError("not_found", "Question not found.");
  if (found.question.answeredAt)
    throw new AppError("conflict", "This question was already answered.");

  const key = await ownerKey(ownerId);
  const { row, recorded } = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(ownerQuestions)
      .set({ answer: key.seal(text, fieldContext(id, "answer")), answeredAt: new Date() })
      .where(and(eq(ownerQuestions.id, id), isNull(ownerQuestions.answeredAt)))
      .returning();
    if (!row) throw new AppError("conflict", "This question was already answered.");
    const job = { kind: "answer", agentId: found.agent.id, questionId: id } as const;
    if (found.agent.webhookUrl) await enqueue(tx, "agent.webhook", job);
    const recorded = await appendLedgerEvent(tx, found.agent, {
      type: "owner.answered",
      actor: "owner",
      data: { questionId: id },
    });
    return { row, recorded };
  });
  await bumpInbox(found.agent.id);
  await broadcast([recorded]);
  return openQuestion(key, row);
}

function toAnswer(key: DataKey, row: OwnerQuestion): OwnerAnswer {
  const view = openQuestion(key, row);
  return {
    questionId: view.id,
    question: view.question,
    answer: view.answer ?? "",
    answeredAt: view.answeredAt ?? "",
  };
}

// Answers are delivered once through the inbox, like messages.
export async function takeAnswers(agent: Agent): Promise<OwnerAnswer[]> {
  const rows = await db
    .update(ownerQuestions)
    .set({ deliveredAt: new Date() })
    .where(
      and(
        eq(ownerQuestions.agentId, agent.id),
        isNotNull(ownerQuestions.answeredAt),
        isNull(ownerQuestions.deliveredAt),
      ),
    )
    .returning();
  if (rows.length === 0) return [];
  const key = await ownerKey(agent.ownerId);
  return rows.map((row) => toAnswer(key, row));
}

export async function answersByIds(agent: Agent, ids: string[]): Promise<OwnerAnswer[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(ownerQuestions)
    .set({ deliveredAt: new Date() })
    .where(
      and(
        eq(ownerQuestions.agentId, agent.id),
        inArray(ownerQuestions.id, ids),
        isNotNull(ownerQuestions.answeredAt),
      ),
    )
    .returning();
  const key = await ownerKey(agent.ownerId);
  return rows.map((row) => toAnswer(key, row));
}
