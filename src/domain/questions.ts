import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import { agents, ownerQuestions, owners, type Agent, type OwnerQuestion } from "../db/schema.ts";
import { enqueue } from "../jobs/queue.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import type { DataKey } from "../lib/encryption.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { telegramEnabled } from "../lib/telegram.ts";
import { bumpInbox } from "./conversations.ts";
import { AppError } from "./errors.ts";
import { formatHandle } from "./handles.ts";
import { ownerKey } from "./keys.ts";
import { appendLedgerEvent, broadcast } from "./ledger.ts";
import { notify } from "./notifications.ts";

export const MAX_QUESTION_LENGTH = 2000;
export const MAX_OPTIONS = 4;
export const MAX_OPTION_LENGTH = 60;
const ANSWER_LINK_MS = 7 * 86_400_000;

export type AnswerChannel = "dashboard" | "email" | "telegram";
export type Reply = string | { option: number };

export type OwnerAnswer = {
  questionId: string;
  question: string;
  answer: string;
  answeredAt: string;
};

const fieldContext = (id: string, field: "question" | "context" | "options" | "answer") =>
  `owner_questions.${field}:${id}`;

function openOptions(key: DataKey, row: OwnerQuestion): string[] {
  const raw = key.open(row.options, fieldContext(row.id, "options"));
  return raw ? (JSON.parse(raw) as string[]) : [];
}

function cleanOptions(raw: string[] | undefined): string[] {
  const options = [...new Set((raw ?? []).map((option) => option.trim()).filter(Boolean))];
  if (options.length > MAX_OPTIONS) {
    throw new AppError("invalid_input", `Offer at most ${MAX_OPTIONS} options.`);
  }
  if (options.some((option) => option.length > MAX_OPTION_LENGTH)) {
    throw new AppError("invalid_input", `Keep each option under ${MAX_OPTION_LENGTH} characters.`);
  }
  if (options.length === 1) {
    throw new AppError("invalid_input", "Offer at least two options, or none for a free answer.");
  }
  return options;
}

export function openQuestion(key: DataKey, row: OwnerQuestion) {
  return {
    id: row.id,
    question: key.open(row.question, fieldContext(row.id, "question")),
    context: key.open(row.context, fieldContext(row.id, "context")),
    options: openOptions(key, row),
    answer: key.open(row.answer, fieldContext(row.id, "answer")),
    askedAt: row.createdAt.toISOString(),
    answeredAt: row.answeredAt?.toISOString() ?? null,
  };
}

export async function askOwner(
  agent: Agent,
  input: { question: string; context?: string | undefined; options?: string[] | undefined },
) {
  const question = input.question.trim();
  if (!question) throw new AppError("invalid_input", "Write the question for your owner.");
  const options = cleanOptions(input.options);
  await rateLimit(`ask-owner:${agent.id}`, 20, 3600);
  const id = uuidv7();
  const token = randomToken("csq");
  const answerUrl = new URL("/answer", config.APP_URL);
  answerUrl.searchParams.set("token", token);
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
        options: key.seal(
          options.length ? JSON.stringify(options) : null,
          fieldContext(id, "options"),
        ),
        answerTokenHash: sha256(token),
      })
      .returning();
    if (!row) throw new Error("question insert returned no row");
    await enqueue(tx, "email.question", {
      email: owner.email,
      handle: formatHandle(agent.handle),
      question,
      url: new URL(`/dashboard?question=${id}`, config.APP_URL).toString(),
      answerUrl: answerUrl.toString(),
      options,
    });
    if (owner.telegramChatId && telegramEnabled()) {
      await enqueue(tx, "telegram.question", { questionId: id });
    }
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

export async function answerQuestion(
  ownerId: string,
  id: string,
  reply: Reply,
  via: AnswerChannel = "dashboard",
) {
  const [found] = await db
    .select({ question: ownerQuestions, agent: agents })
    .from(ownerQuestions)
    .innerJoin(agents, eq(agents.id, ownerQuestions.agentId))
    .where(and(eq(ownerQuestions.id, id), eq(agents.ownerId, ownerId)));
  if (!found) throw new AppError("not_found", "Question not found.");
  if (found.question.answeredAt)
    throw new AppError("conflict", "This question was already answered.");

  const key = await ownerKey(ownerId);
  const text =
    typeof reply === "string" ? reply.trim() : openOptions(key, found.question)[reply.option];
  if (!text) {
    throw new AppError(
      "invalid_input",
      typeof reply === "string" ? "Write an answer." : "That option doesn't exist.",
    );
  }
  const { row, recorded } = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(ownerQuestions)
      .set({
        answer: key.seal(text, fieldContext(id, "answer")),
        answeredAt: new Date(),
        answerTokenHash: null,
      })
      .where(and(eq(ownerQuestions.id, id), isNull(ownerQuestions.answeredAt)))
      .returning();
    if (!row) throw new AppError("conflict", "This question was already answered.");
    const job = { kind: "answer", agentId: found.agent.id, questionId: id } as const;
    await notify(tx, found.agent, job);
    const recorded = await appendLedgerEvent(tx, found.agent, {
      type: "owner.answered",
      actor: "owner",
      data: { questionId: id, via },
    });
    return { row, recorded };
  });
  await bumpInbox(found.agent.id);
  await broadcast([recorded]);
  return openQuestion(key, row);
}

async function questionByToken(token: string) {
  const [found] = await db
    .select({ question: ownerQuestions, agent: agents })
    .from(ownerQuestions)
    .innerJoin(agents, eq(agents.id, ownerQuestions.agentId))
    .where(eq(ownerQuestions.answerTokenHash, sha256(token)));
  if (!found || found.question.createdAt.getTime() + ANSWER_LINK_MS < Date.now()) {
    throw new AppError(
      "not_found",
      "This link has expired or the question was already answered. Open your dashboard to see it.",
    );
  }
  return found;
}

// Email links open a confirmation page instead of answering on GET, so link scanners that
// prefetch URLs can't answer for the owner.
export async function answerLinkView(token: string) {
  const { question, agent } = await questionByToken(token);
  const {
    id,
    question: text,
    context,
    options,
    askedAt,
  } = openQuestion(await ownerKey(agent.ownerId), question);
  return { id, agent: formatHandle(agent.handle), question: text, context, options, askedAt };
}

export async function answerByLink(token: string, reply: Reply) {
  const { question, agent } = await questionByToken(token);
  const answered = await answerQuestion(agent.ownerId, question.id, reply, "email");
  return { agent: formatHandle(agent.handle), answer: answered.answer };
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
