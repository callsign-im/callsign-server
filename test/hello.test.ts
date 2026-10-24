import { describe, expect, it } from "vitest";
import type { Agent } from "../src/db/schema.ts";
import { createGroup, respondToGroupInvite } from "../src/domain/groups.ts";
import { detectIntent, detectLang, ensureHelloAgent } from "../src/domain/hello.ts";
import { checkInbox, sendMessage } from "../src/domain/messaging.ts";
import { updateTask } from "../src/domain/plans.ts";
import { processDueJobs } from "../src/jobs/runner.ts";
import { createAgentWithToken } from "./helpers.ts";

async function drainJobs() {
  while ((await processDueJobs()) > 0);
}

async function say(agent: Agent, body: string) {
  await sendMessage(agent, { to: "@hello", body });
  await drainJobs();
  const inbox = await checkInbox(agent);
  return {
    inbox,
    replies: inbox.threads
      .filter((thread) => thread.with?.handle === "@hello")
      .flatMap((thread) => thread.messages),
  };
}

describe("@hello", () => {
  it("is created once and its handle can't be claimed", async () => {
    const first = await ensureHelloAgent();
    expect(await ensureHelloAgent()).toMatchObject({ id: first.id });
    await expect(createAgentWithToken("hello")).rejects.toThrow(/reserved/);
  });

  it("reads keywords in English and Spanish", () => {
    expect(detectIntent("Can you show me plans?")).toBe("plan");
    expect(detectIntent("quiero probar un grupo")).toBe("group");
    expect(detectIntent("how do I get woken up? wake")).toBe("wake");
    expect(detectIntent("hi!")).toBe("menu");
    expect(detectLang("hola, ¿cómo funciona?")).toBe("es");
    expect(detectLang("hi there")).toBe("en");
  });

  it("answers the first message with the menu and accepts the request", async () => {
    await ensureHelloAgent();
    const { agent } = await createAgentWithToken("newbie");
    const { replies } = await say(agent, "Hi!");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body).toContain("Reply with one word");
    expect(replies[0]?.body).toContain("no AI");
  });

  it("only repeats the menu every few minutes, so bots can't loop with it", async () => {
    await ensureHelloAgent();
    const { agent } = await createAgentWithToken("chatty");
    await say(agent, "Hello");
    expect((await say(agent, "Thanks, that's great")).replies).toHaveLength(0);
    expect((await say(agent, "wake")).replies[0]?.body).toContain("callsign-cli listen");
  });

  it("shares a plan and congratulates the agent when it finishes its task", async () => {
    await ensureHelloAgent();
    const { agent } = await createAgentWithToken("planner");
    const { replies, inbox } = await say(agent, "show me a plan");
    expect(replies[0]?.body).toContain("update_task");
    expect(inbox.notices.map((notice) => notice.kind)).toEqual(
      expect.arrayContaining(["plan.shared"]),
    );

    const planId = /plan ([0-9a-f-]{36})/.exec(replies[0]?.body ?? "")?.[1] ?? "";
    await updateTask(agent, planId, "try", { status: "done" });
    await drainJobs();
    const thread = (await checkInbox(agent)).threads.find((t) => t.with?.handle === "@hello");
    expect(thread?.messages[0]?.body).toContain("You finished the plan");
  });

  it("invites to a test group in Spanish and answers mentions there", async () => {
    await ensureHelloAgent();
    const { agent } = await createAgentWithToken("grupal");
    const { replies, inbox } = await say(agent, "hola, quiero probar un grupo");
    expect(replies[0]?.body).toContain("Te invité a #hello-grupal");
    expect(inbox.threads.some((t) => t.kind === "invitation")).toBe(true);

    await respondToGroupInvite(agent, "#hello-grupal", "accept", "agent");
    await sendMessage(agent, { to: "#hello-grupal", body: "no mention here" });
    await sendMessage(agent, { to: "#hello-grupal", body: "@hello estoy en el grupo" });
    await drainJobs();
    const group = (await checkInbox(agent)).threads.find((t) => t.group);
    expect(group?.messages.map((m) => m.body)).toEqual([expect.stringContaining("Te leí")]);
  });

  it("sends a file as an attachment", async () => {
    await ensureHelloAgent();
    const { agent } = await createAgentWithToken("filer");
    const { replies } = await say(agent, "file please");
    expect(replies[0]?.attachments).toEqual([
      expect.objectContaining({ name: "welcome.txt", mimeType: "text/plain" }),
    ]);
  });

  it("declines group invitations from others", async () => {
    await ensureHelloAgent();
    const { agent } = await createAgentWithToken("inviter");
    await say(agent, "hi");
    await createGroup(agent, { name: "party", members: ["@hello"] });
    await drainJobs();
    const inbox = await checkInbox(agent);
    expect(inbox.threads.filter((t) => t.group)).toHaveLength(0);
  });
});
