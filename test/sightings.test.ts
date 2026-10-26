import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, sql } from "../src/db/client.ts";
import { agents, jobs, securityAlerts, tokenSightings } from "../src/db/schema.ts";
import { createAgent, createAgentToken } from "../src/domain/agents.ts";
import { listLedger } from "../src/domain/ledger.ts";
import { createSession } from "../src/domain/owners.ts";
import { checkSighting } from "../src/domain/sightings.ts";
import { createApp } from "../src/http/app.ts";
import { createAgentWithToken } from "./helpers.ts";

const app = createApp();

async function owned(handle: string) {
  const created = await createAgentWithToken(handle);
  const { sessionToken } = await createSession(db, created.owner.id);
  return { ...created, cookie: `callsign_session=${sessionToken}` };
}

function fromIp(token: string, ip: string) {
  return app.request("/v1/agent/me", {
    headers: {
      authorization: `Bearer ${token}`,
      "x-forwarded-for": ip,
      "user-agent": "claude-code/2.1",
    },
  });
}

function dashboard(cookie: string, path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(path, {
    method: init.method ?? "GET",
    headers: { cookie, origin: "http://localhost:3001", "content-type": "application/json" },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
}

async function runChecks() {
  const pending = await db.select().from(jobs).where(eq(jobs.kind, "sighting.check"));
  for (const job of pending) {
    await checkSighting(job.payload as { sightingId: string });
    await db.delete(jobs).where(eq(jobs.id, job.id));
  }
}

async function freezeLink(): Promise<string> {
  const [job] = await db.select().from(jobs).where(eq(jobs.kind, "alert.email"));
  return new URL(String(job?.payload.freezeUrl)).searchParams.get("token") ?? "";
}

describe("token sightings and alerts", () => {
  it("records where each token is used from, sealed, and shows it to the owner", async () => {
    const alice = await owned("alice_agent");
    await fromIp(alice.token, "203.0.113.7");
    await fromIp(alice.token, "203.0.113.7");
    await runChecks();

    const rows = await db.select().from(tokenSightings);
    expect(rows).toHaveLength(1);
    const [raw] = await sql<
      { row: string }[]
    >`select row_to_json(t)::text as row from token_sightings t`;
    expect(raw?.row).not.toContain("203.0.113");
    expect(raw?.row).not.toContain("claude-code");

    const tokens = (await (
      await dashboard(alice.cookie, "/v1/agents/alice_agent/tokens")
    ).json()) as {
      tokens: { id: string; usage: unknown }[];
    };
    expect(tokens.tokens[0]?.usage).toMatchObject({
      addresses: 1,
      last: { ip: "203.0.113.7", network: "203.0.113.0/24", userAgent: "claude-code/2.1" },
    });
    const networks = await dashboard(alice.cookie, "/v1/agents/alice_agent/networks");
    expect(await networks.json()).toMatchObject({
      networks: [{ label: "203.0.113.0/24", status: "known" }],
    });
    expect(await db.select().from(securityAlerts)).toEqual([]);
  });

  it("alerts the owner about a new network until they say it was them", async () => {
    const alice = await owned("alice_agent");
    await fromIp(alice.token, "203.0.113.7");
    await runChecks();
    await fromIp(alice.token, "198.51.100.20");
    await runChecks();

    const listed = (await (await dashboard(alice.cookie, "/v1/alerts")).json()) as {
      alerts: { id: string }[];
    };
    expect(listed.alerts).toMatchObject([
      {
        agent: "@alice_agent",
        kind: "new_network",
        status: "open",
        details: { ip: "198.51.100.20", network: "198.51.100.0/24", client: "test" },
      },
    ]);
    const kinds = (await db.select().from(jobs)).map((job) => job.kind).sort();
    expect(kinds).toEqual(["alert.email", "alert.telegram"]);
    const [latest] = await listLedger(alice.agent, { limit: 1 });
    expect(latest).toMatchObject({ type: "security.alert", actor: "system" });

    const id = listed.alerts[0]!.id;
    expect((await dashboard(alice.cookie, `/v1/alerts/${id}/ack`, { method: "POST" })).status).toBe(
      204,
    );
    const networks = (await (
      await dashboard(alice.cookie, "/v1/agents/alice_agent/networks")
    ).json()) as {
      networks: { status: string }[];
    };
    expect(networks.networks.map((network) => network.status)).toEqual(["known", "known"]);

    await fromIp(alice.token, "198.51.100.21");
    await runChecks();
    expect(await db.select().from(securityAlerts)).toHaveLength(1);
  });

  it("freezes from the emailed link only after a deliberate click", async () => {
    const alice = await owned("alice_agent");
    await fromIp(alice.token, "203.0.113.7");
    await runChecks();
    await fromIp(alice.token, "198.51.100.20");
    await runChecks();
    const token = await freezeLink();

    const opened = await app.request(`/v1/freeze-links/${token}`);
    expect(await opened.json()).toMatchObject({
      alert: { agent: "@alice_agent", kind: "new_network", frozen: false },
    });
    const [untouched] = await db.select().from(agents).where(eq(agents.id, alice.agent.id));
    expect(untouched?.frozenAt).toBeNull();

    const clicked = await app.request(`/v1/freeze-links/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "freeze" }),
    });
    expect(await clicked.json()).toMatchObject({ alert: { status: "frozen", frozen: true } });
    expect((await fromIp(alice.token, "203.0.113.7")).status).toBe(403);
    const [frozen] = await listLedger(alice.agent, { limit: 1 });
    expect(frozen).toMatchObject({ type: "agent.frozen", data: { via: "email" } });
  });

  it("alerts once when an agent sends a burst of messages", async () => {
    const alice = await createAgentWithToken("alice_agent");
    await createAgent(alice.owner, { handle: "alice_helper", product: "custom" });
    for (let i = 0; i < 31; i += 1) {
      const sent = await app.request("/v1/agent/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" },
        body: JSON.stringify({ to: "@alice_helper", body: `Update ${i}` }),
      });
      expect(sent.status).toBe(201);
    }
    expect(await db.select().from(securityAlerts)).toMatchObject([
      { kind: "burst", agentId: alice.agent.id },
    ]);
  });

  it("only remembers the first network as the baseline", async () => {
    const alice = await createAgentWithToken("alice_agent");
    const second = await createAgentToken(alice.agent, "second");
    await Promise.all([fromIp(alice.token, "203.0.113.7"), fromIp(second.token, "192.0.2.4")]);
    await Promise.all(
      (await db.select().from(jobs).where(eq(jobs.kind, "sighting.check"))).map((job) =>
        checkSighting(job.payload as { sightingId: string }),
      ),
    );
    expect(await db.select().from(securityAlerts)).toHaveLength(1);
  });
});
