import { describe, expect, it } from "vitest";
import {
  checkInbox,
  decideContact,
  getConversation,
  PENDING_MESSAGE_LIMIT,
  sendMessage,
} from "../src/domain/messaging.ts";
import { createAgentWithToken } from "./helpers.ts";

async function pair() {
  const { agent: alice } = await createAgentWithToken("alice_agent");
  const { agent: bob } = await createAgentWithToken("bob_agent");
  return { alice, bob };
}

describe("messaging", () => {
  it("delivers the first message as a request and the reply accepts it", async () => {
    const { alice, bob } = await pair();

    const first = await sendMessage(alice, { to: "@bob_agent", body: "Hi Bob" });
    expect(first.status).toBe("request_sent");

    const inbox = await checkInbox(bob);
    expect(inbox.threads).toHaveLength(1);
    expect(inbox.threads[0]?.kind).toBe("request");
    expect(inbox.threads[0]?.messages.map((m) => m.body)).toEqual(["Hi Bob"]);

    const reply = await sendMessage(bob, { to: "alice_agent", body: "Hi Alice" });
    expect(reply.status).toBe("delivered");

    const next = await sendMessage(alice, { to: "@bob_agent", body: "Great" });
    expect(next.status).toBe("delivered");
  });

  it("limits messages until the request is accepted", async () => {
    const { alice, bob } = await pair();
    for (let i = 0; i < PENDING_MESSAGE_LIMIT; i++) {
      await sendMessage(alice, { to: "@bob_agent", body: `ping ${i}` });
    }
    await expect(sendMessage(alice, { to: "@bob_agent", body: "one more" })).rejects.toMatchObject({
      code: "rate_limited",
    });

    await decideContact(bob, "@alice_agent", "accept", "agent");
    const sent = await sendMessage(alice, { to: "@bob_agent", body: "thanks" });
    expect(sent.status).toBe("delivered");
  });

  it("rejects messages after a decline or block", async () => {
    const { alice, bob } = await pair();
    await sendMessage(alice, { to: "@bob_agent", body: "Hi" });
    await decideContact(bob, "@alice_agent", "decline", "agent");
    await expect(sendMessage(alice, { to: "@bob_agent", body: "Hi?" })).rejects.toMatchObject({
      code: "forbidden",
    });

    await decideContact(bob, "@alice_agent", "block", "owner");
    await expect(sendMessage(bob, { to: "@alice_agent", body: "Hi" })).rejects.toMatchObject({
      code: "forbidden",
    });

    const unblocked = await decideContact(bob, "@alice_agent", "unblock", "owner");
    expect(unblocked.status).toBe("active");
    const sent = await sendMessage(alice, { to: "@bob_agent", body: "Hello again" });
    expect(sent.status).toBe("delivered");
  });

  it("supports blocking an agent before any contact", async () => {
    const { alice, bob } = await pair();
    await decideContact(bob, "@alice_agent", "block", "agent");
    await expect(sendMessage(alice, { to: "@bob_agent", body: "Hi" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("replays sends that reuse an idempotency key", async () => {
    const { alice, bob } = await pair();
    const first = await sendMessage(alice, { to: "@bob_agent", body: "Hi", idempotencyKey: "k-1" });
    const retry = await sendMessage(alice, { to: "@bob_agent", body: "Hi", idempotencyKey: "k-1" });
    expect(retry.messageId).toBe(first.messageId);

    const conversation = await getConversation(bob, "@alice_agent", { limit: 10, markRead: false });
    expect(conversation.messages).toHaveLength(1);

    const { agent: carol } = await createAgentWithToken("carol_agent");
    await expect(
      sendMessage(alice, { to: carol.handle, body: "Hi", idempotencyKey: "k-1" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("does not mark unread messages as read when the agent sends", async () => {
    const { alice, bob } = await pair();
    await sendMessage(alice, { to: "@bob_agent", body: "Question?" });
    await sendMessage(bob, { to: "@alice_agent", body: "Unrelated update" });

    const inbox = await checkInbox(bob);
    expect(inbox.threads[0]?.messages.map((m) => m.body)).toEqual(["Question?"]);
  });

  it("serves an empty inbox from cache until something new arrives", async () => {
    const { alice, bob } = await pair();
    expect((await checkInbox(bob)).threads).toHaveLength(0);
    expect((await checkInbox(bob)).threads).toHaveLength(0);

    await sendMessage(alice, { to: "@bob_agent", body: "New" });
    expect((await checkInbox(bob)).threads).toHaveLength(1);
    expect((await checkInbox(bob)).threads).toHaveLength(0);
  });

  it("rejects unknown recipients and self messages", async () => {
    const { alice } = await pair();
    await expect(sendMessage(alice, { to: "@nobody_here", body: "Hi" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(sendMessage(alice, { to: "@alice_agent", body: "Hi" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
