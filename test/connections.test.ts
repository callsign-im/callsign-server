import { describe, expect, it } from "vitest";
import { createAgentToken } from "../src/domain/agents.ts";
import { askOwner, answerQuestion } from "../src/domain/questions.ts";
import { sendMessage, type Inbox } from "../src/domain/messaging.ts";
import { createApp } from "../src/http/app.ts";
import { createAgentWithToken } from "./helpers.ts";

const app = createApp();

async function inbox(token: string): Promise<Inbox> {
  const res = await app.request("/v1/agent/inbox", {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as Inbox;
}

const bodies = (box: Inbox) => box.threads.flatMap((thread) => thread.messages.map((m) => m.body));

describe("reading from several clients", () => {
  it("gives every connection each new message once", async () => {
    const { agent: alice, owner, token: claude } = await createAgentWithToken("alice_agent");
    const { token: opencode } = await createAgentToken(alice, "opencode");
    const { agent: bob } = await createAgentWithToken("bob_agent");

    await sendMessage(bob, { to: "@alice_agent", body: "Can you send the budget?" });
    expect(bodies(await inbox(claude))).toEqual(["Can you send the budget?"]);
    expect(bodies(await inbox(opencode))).toEqual(["Can you send the budget?"]);
    expect(bodies(await inbox(claude))).toEqual([]);
    expect(bodies(await inbox(opencode))).toEqual([]);

    await sendMessage(bob, { to: "@alice_agent", body: "Never mind, found it." });
    const asked = await askOwner(alice, { question: "Share it?", options: ["Yes", "No"] });
    await answerQuestion(owner.id, asked.id, { option: 0 });
    for (const token of [opencode, claude]) {
      const box = await inbox(token);
      expect(bodies(box)).toEqual(["Never mind, found it."]);
      expect(box.ownerAnswers.map((answer) => answer.answer)).toEqual(["Yes"]);
    }
  });

  it("shows a new connection what nobody has read yet", async () => {
    const { agent: alice, token: first } = await createAgentWithToken("alice_agent");
    const { agent: bob } = await createAgentWithToken("bob_agent");
    await sendMessage(bob, { to: "@alice_agent", body: "Hello before you connected" });

    const { token: later } = await createAgentToken(alice, "Claude Code");
    expect(bodies(await inbox(later))).toEqual(["Hello before you connected"]);
    expect(bodies(await inbox(first))).toEqual(["Hello before you connected"]);
    expect(bodies(await inbox(later))).toEqual([]);
  });
});
