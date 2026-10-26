import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { db } from "../src/db/client.ts";
import { jobs, type Agent, type Owner } from "../src/db/schema.ts";
import { listLedger } from "../src/domain/ledger.ts";
import { findAgents } from "../src/domain/contacts.ts";
import { checkInbox, lookupAgent, sendMessage } from "../src/domain/messaging.ts";
import { createSession } from "../src/domain/owners.ts";
import { reportAgent } from "../src/domain/reports.ts";
import { createApp } from "../src/http/app.ts";
import { createAgentWithToken } from "./helpers.ts";

afterEach(() => {
  config.ADMIN_EMAILS.splice(0);
});

async function spammedBy(spammer: Agent, handle: string) {
  const victim = await createAgentWithToken(handle);
  await sendMessage(spammer, { to: `@${handle}`, body: "Claim your free crypto at scam.example" });
  return victim;
}

async function ownerHeaders(owner: Owner) {
  const { sessionToken } = await createSession(db, owner.id);
  return {
    cookie: `callsign_session=${sessionToken}`,
    "content-type": "application/json",
    origin: "http://localhost:3001",
  };
}

describe("reports", () => {
  it("blocks the reported agent and keeps its last messages as evidence", async () => {
    const { agent: spammer } = await createAgentWithToken("spammer");
    const { agent: victim } = await spammedBy(spammer, "victim");

    const outcome = await reportAgent(victim, { handle: "@spammer", reason: "scam" }, "agent");
    expect(outcome).toEqual({ reported: "@spammer", status: "received", blocked: true });
    await expect(sendMessage(spammer, { to: "@victim", body: "hello?" })).rejects.toThrow(
      /not accepting messages/,
    );
    expect(
      (await reportAgent(victim, { handle: "@spammer", reason: "spam" }, "agent")).status,
    ).toBe("already_reported");
  });

  it("only accepts reports about agents that wrote to the reporter", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    await createAgentWithToken("bob_agent");
    await expect(
      reportAgent(alice, { handle: "@bob_agent", reason: "spam" }, "agent"),
    ).rejects.toThrow(/hasn't messaged you/);
    await expect(
      reportAgent(alice, { handle: "@alice_agent", reason: "spam" }, "agent"),
    ).rejects.toThrow(/your own agents/);
  });

  it("suspends an agent reported by three owners and tells everyone", async () => {
    config.ADMIN_EMAILS.push("admin@example.com");
    const { agent: spammer, token } = await createAgentWithToken("spammer");
    for (const handle of ["victim_one", "victim_two", "victim_three"]) {
      const { agent } = await spammedBy(spammer, handle);
      await reportAgent(agent, { handle: "@spammer", reason: "spam" }, "agent");
    }

    const emails = await db.select().from(jobs).where(eq(jobs.kind, "email.report"));
    expect(emails).toHaveLength(3);
    expect(emails.at(-1)?.payload).toMatchObject({ reporters: 3, suspended: true });
    expect(await db.select().from(jobs).where(eq(jobs.kind, "email.suspended"))).toHaveLength(1);

    const app = createApp();
    const me = await app.request("/v1/agent/me", { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(403);
    expect(await me.text()).toContain("suspended");

    const [suspended] = await listLedger(spammer, { limit: 1 });
    expect(suspended).toMatchObject({ type: "agent.suspended", actor: "system" });

    const { agent: other } = await createAgentWithToken("bystander");
    await expect(sendMessage(other, { to: "@spammer", body: "hi" })).rejects.toThrow(/suspended/);
    await expect(lookupAgent(other, "@spammer")).rejects.toThrow(/suspended/);
    expect(await findAgents(other, "@spammer")).toEqual([]);
  });

  it("lets owners report from the dashboard and admins review", async () => {
    const { agent: spammer } = await createAgentWithToken("spammer");
    const { owner } = await spammedBy(spammer, "victim");
    await checkInbox((await createAgentWithToken("unrelated")).agent);
    const app = createApp();
    const headers = await ownerHeaders(owner);

    const reported = await app.request("/v1/agents/victim/reports", {
      method: "POST",
      headers,
      body: JSON.stringify({ handle: "@spammer", reason: "scam", details: "Asked for my keys" }),
    });
    expect(reported.status).toBe(201);

    expect((await app.request("/v1/admin/reports", { headers })).status).toBe(404);
    config.ADMIN_EMAILS.push(owner.email);
    const me = (await (await app.request("/v1/me", { headers })).json()) as {
      owner: { admin: boolean };
    };
    expect(me.owner.admin).toBe(true);

    const { reports } = (await (await app.request("/v1/admin/reports", { headers })).json()) as {
      reports: { id: string; details: string; evidence: { body: string }[]; agent: object }[];
    };
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      details: "Asked for my keys",
      evidence: [{ body: "Claim your free crypto at scam.example" }],
      agent: { handle: "@spammer", openReports: 1, suspendedAt: null },
    });

    const suspended = await app.request("/v1/admin/agents/spammer/suspension", {
      method: "POST",
      headers,
      body: JSON.stringify({ suspended: true }),
    });
    const { agent } = (await suspended.json()) as {
      agent: { handle: string; openReports: number; suspendedAt: string | null };
    };
    expect(agent).toMatchObject({ handle: "@spammer", openReports: 0 });
    expect(agent.suspendedAt).not.toBeNull();
    const closed = (await (
      await app.request("/v1/admin/reports?status=closed", { headers })
    ).json()) as { reports: { status: string }[] };
    expect(closed.reports.map((r) => r.status)).toEqual(["actioned"]);

    await app.request("/v1/admin/agents/spammer/suspension", {
      method: "POST",
      headers,
      body: JSON.stringify({ suspended: false }),
    });
    const { agents } = (await (await app.request("/v1/admin/suspended", { headers })).json()) as {
      agents: unknown[];
    };
    expect(agents).toEqual([]);
  });
});
