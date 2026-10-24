import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import type { Owner } from "../src/db/schema.ts";
import { createHandoff, latestHandoff } from "../src/domain/handoffs.ts";
import { checkInbox, sendMessage } from "../src/domain/messaging.ts";
import { createSession } from "../src/domain/owners.ts";
import { createPlan, getPlan } from "../src/domain/plans.ts";
import { createApp } from "../src/http/app.ts";
import { serverInstructions } from "../src/mcp/guide.ts";
import { createAgentWithToken } from "./helpers.ts";

const app = createApp();

async function partners() {
  const alice = await createAgentWithToken("alice_agent");
  const bob = await createAgentWithToken("bob_agent");
  await sendMessage(alice.agent, { to: "@bob_agent", body: "Let's plan the launch." });
  await sendMessage(bob.agent, { to: "@alice_agent", body: "Sure." });
  await checkInbox(alice.agent);
  await checkInbox(bob.agent);
  return { alice, bob };
}

async function ownerHeaders(owner: Owner) {
  const { sessionToken } = await createSession(db, owner.id);
  return {
    cookie: `callsign_session=${sessionToken}`,
    "content-type": "application/json",
    origin: "http://localhost:3001",
  };
}

describe("handoffs", () => {
  it("lets the next session pick up where the last one stopped", async () => {
    const { token } = await createAgentWithToken("alice_agent");
    const saved = await app.request("/v1/agent/handoffs", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        summary: "Migrated the billing tables; tests pass.",
        next: "Deploy, then delete the old columns.",
        files: ["src/db/schema.ts", "drizzle/0014_billing.sql"],
      }),
    });
    expect(saved.status).toBe(201);

    const latest = await app.request("/v1/agent/handoffs/latest", {
      headers: { authorization: `Bearer ${token}` },
    });
    const { handoff } = (await latest.json()) as { handoff: Record<string, unknown> };
    expect(handoff).toMatchObject({
      by: "@alice_agent",
      client: "test",
      summary: "Migrated the billing tables; tests pass.",
      next: "Deploy, then delete the old columns.",
      files: ["src/db/schema.ts", "drizzle/0014_billing.sql"],
      planId: null,
    });
  });

  it("puts the latest note in the instructions a new session reads", async () => {
    const { agent } = await createAgentWithToken("alice_agent");
    await createHandoff(agent, { summary: "Halfway through the invoice." }, "Claude Code");
    const instructions = serverInstructions(agent, null, await latestHandoff(agent));
    expect(instructions).toContain("from Claude Code");
    expect(instructions).toContain("Halfway through the invoice.");
  });

  it("shares a handoff with the plan's members", async () => {
    const { alice, bob } = await partners();
    const plan = await createPlan(alice.agent, {
      with: "@bob_agent",
      title: "Launch",
      tasks: [{ key: "ads", title: "Ads", assignee: "@bob_agent" }],
    });
    await checkInbox(bob.agent);

    await createHandoff(
      alice.agent,
      { summary: "The copy is in the shared doc.", next: "Bob picks the images.", plan: plan.id },
      "opencode",
    );
    const inbox = await checkInbox(bob.agent);
    expect(inbox.notices).toEqual([
      expect.objectContaining({ kind: "handoff", from: "@alice_agent" }),
    ]);
    expect(inbox.notices[0]?.text).toContain("Next: Bob picks the images.");

    const res = await app.request("/v1/agents/bob_agent/plans", {
      headers: await ownerHeaders(bob.owner),
    });
    const body = (await res.json()) as { plans: { handoff: { summary: string } | null }[] };
    expect(body.plans[0]?.handoff?.summary).toBe("The copy is in the shared doc.");
  });
});

describe("editing tasks from the dashboard", () => {
  it("updates a task on the agent's behalf and says the owner did it", async () => {
    const { alice, bob } = await partners();
    const plan = await createPlan(alice.agent, {
      with: "@bob_agent",
      title: "Launch",
      tasks: [{ key: "ads", title: "Ads", assignee: "@bob_agent" }],
    });
    await checkInbox(alice.agent);

    const res = await app.request(`/v1/agents/bob_agent/plans/${plan.id}/tasks/ads`, {
      method: "PATCH",
      headers: await ownerHeaders(bob.owner),
      body: JSON.stringify({ status: "done", note: "Bought the slots myself" }),
    });
    expect(res.status).toBe(200);
    expect((await getPlan(alice.agent, plan.id)).tasks[0]).toMatchObject({ status: "done" });
    expect((await checkInbox(alice.agent)).notices[0]?.text).toContain(
      "@bob_agent's owner finished",
    );

    const forbidden = await app.request(`/v1/agents/bob_agent/plans/${plan.id}/tasks/ads`, {
      method: "PATCH",
      headers: await ownerHeaders(alice.owner),
      body: JSON.stringify({ status: "todo" }),
    });
    expect(forbidden.status).toBe(404);
  });
});
