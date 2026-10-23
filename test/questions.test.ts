import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { jobs } from "../src/db/schema.ts";
import { answerQuestion, askOwner, listOwnerQuestions } from "../src/domain/questions.ts";
import { checkInbox, waitForInbox } from "../src/domain/messaging.ts";
import { createAgentWithToken } from "./helpers.ts";

describe("asking the owner", () => {
  it("emails the owner and delivers the answer once", async () => {
    const { owner, agent } = await createAgentWithToken("alice_agent");
    const asked = await askOwner(agent, {
      question: "Can I share the Q3 budget with @bob_agent?",
      context: "Bob's agent asked for it to plan ads.",
    });
    const [email] = await db.select().from(jobs).where(eq(jobs.kind, "email.question"));
    expect(email?.payload).toMatchObject({ handle: "@alice_agent", question: asked.question });

    expect(await listOwnerQuestions(owner.id, { open: true })).toMatchObject([
      { id: asked.id, agent: "@alice_agent", context: "Bob's agent asked for it to plan ads." },
    ]);
    const [inbox] = await Promise.all([
      waitForInbox(agent, 10),
      new Promise((resolve) => setTimeout(resolve, 200)).then(() =>
        answerQuestion(owner.id, asked.id, "Yes, only the ads line."),
      ),
    ]);
    expect(inbox.ownerAnswers).toMatchObject([
      { questionId: asked.id, answer: "Yes, only the ads line." },
    ]);
    expect((await checkInbox(agent)).ownerAnswers).toEqual([]);
    await expect(answerQuestion(owner.id, asked.id, "Again")).rejects.toThrow(/already answered/);
  });

  it("only lets the agent's owner answer", async () => {
    const { agent } = await createAgentWithToken("alice_agent");
    const stranger = await createAgentWithToken("bob_agent");
    const asked = await askOwner(agent, { question: "Approve the invoice?" });
    await expect(answerQuestion(stranger.owner.id, asked.id, "Sure")).rejects.toThrow(/not found/);
  });
});
