import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { agentTokens, eventSubscriptions, jobs } from "../src/db/schema.ts";
import { revokeAgentToken, updateAgent } from "../src/domain/agents.ts";
import { freezeAgent } from "../src/domain/freeze.ts";
import { listLedger } from "../src/domain/ledger.ts";
import { checkInbox, sendMessage, waitForInbox } from "../src/domain/messaging.ts";
import { createSession } from "../src/domain/owners.ts";
import { createApp } from "../src/http/app.ts";
import { createAgentWithToken } from "./helpers.ts";
import { elevate, enrollPasskey } from "./webauthn.ts";

const app = createApp();

async function owned(handle: string) {
  const created = await createAgentWithToken(handle);
  const { sessionToken } = await createSession(db, created.owner.id);
  return { ...created, cookie: `callsign_session=${sessionToken}` };
}

function dashboard(cookie: string, path: string, body: unknown = {}) {
  return app.request(path, {
    method: "POST",
    headers: { cookie, origin: "http://localhost:3001", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asAgent(token: string, path: string) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

function mcpList(token: string) {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("freezing an agent", () => {
  it("refuses every call over REST and MCP until the owner unfreezes it", async () => {
    const alice = await owned("alice_agent");
    const frozen = await dashboard(alice.cookie, "/v1/agents/alice_agent/freeze");
    const { agent: frozenView } = (await frozen.json()) as { agent: { frozenAt: string | null } };
    expect(frozenView.frozenAt).not.toBeNull();

    const rest = await asAgent(alice.token, "/v1/agent/me");
    expect(rest.status).toBe(403);
    expect(await rest.json()).toMatchObject({ error: { code: "agent_frozen" } });
    const mcp = await mcpList(alice.token);
    expect(mcp.status).toBe(403);
    expect(JSON.stringify(await mcp.json())).toContain("frozen");

    const minted = await dashboard(alice.cookie, "/v1/agents/alice_agent/tokens");
    expect(minted.status).toBe(409);
    const [latest] = await listLedger(alice.agent, { limit: 1 });
    expect(latest).toMatchObject({
      type: "agent.frozen",
      actor: "owner",
      data: { via: "dashboard" },
    });

    const thawed = await dashboard(alice.cookie, "/v1/agents/alice_agent/unfreeze");
    expect(await thawed.json()).toMatchObject({ agent: { frozenAt: null }, revokedTokens: 0 });
    expect((await asAgent(alice.token, "/v1/agent/me")).status).toBe(200);
    const inbox = (await (await asAgent(alice.token, "/v1/agent/inbox")).json()) as {
      notices: { kind: string }[];
    };
    expect(inbox.notices.map((notice) => notice.kind)).toEqual(["agent.unfrozen"]);
  });

  it("ends open waits within a couple of seconds", async () => {
    const alice = await owned("alice_agent");
    const started = Date.now();
    const [waited] = await Promise.all([
      asAgent(alice.token, "/v1/agent/inbox?wait=30"),
      new Promise((resolve) => setTimeout(resolve, 300)).then(() =>
        freezeAgent(alice.agent, { actor: "owner", via: "dashboard" }),
      ),
    ]);
    expect(waited.status).toBe(403);
    expect(Date.now() - started).toBeLessThan(3000);

    const bob = await createAgentWithToken("bob_agent");
    const tokenId = await tokenIdOf(bob.agent.id);
    const revokedAt = Date.now();
    const [outcome] = await Promise.all([
      waitForInbox(bob.agent, 30, { tokenId }).catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(resolve, 300)).then(() =>
        revokeAgentToken(bob.agent, tokenId),
      ),
    ]);
    expect(outcome).toMatchObject({ code: "unauthorized" });
    expect(Date.now() - revokedAt).toBeLessThan(3000);
  });

  it("keeps receiving messages without waking the agent", async () => {
    const alice = await owned("alice_agent");
    const bob = await createAgentWithToken("bob_agent");
    const configured = await updateAgent(bob.agent, {
      webhookUrl: "https://hooks.example.com/bob",
    });
    await db.insert(eventSubscriptions).values({
      id: "sub-bob",
      agentId: bob.agent.id,
      tokenId: await tokenIdOf(bob.agent.id),
      name: "message.received",
      arguments: {},
      url: "https://hooks.example.com/events",
      secret: { ciphertext: "v1.unused" },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const frozenBob = await freezeAgent(configured, { actor: "owner", via: "dashboard" });
    expect(await db.select().from(eventSubscriptions)).toEqual([]);

    await sendMessage(alice.agent, { to: "@bob_agent", body: "Still there?" });
    expect(await db.select().from(jobs).where(eq(jobs.kind, "agent.webhook"))).toEqual([]);
    const inbox = await checkInbox(frozenBob);
    expect(inbox.threads[0]?.messages.map((message) => message.body)).toEqual(["Still there?"]);
  });

  it("asks owners with a passkey to confirm the unfreeze, never the freeze", async () => {
    const alice = await owned("alice_agent");
    const passkey = await enrollPasskey(app, alice.cookie);

    const frozen = await dashboard(alice.cookie, "/v1/agents/alice_agent/freeze");
    expect(frozen.status).toBe(200);
    const blocked = await dashboard(alice.cookie, "/v1/agents/alice_agent/unfreeze");
    expect(await blocked.json()).toMatchObject({ error: { code: "step_up_required" } });

    await elevate(app, alice.cookie, passkey);
    const thawed = await dashboard(alice.cookie, "/v1/agents/alice_agent/unfreeze", {
      revokeTokens: true,
    });
    expect(await thawed.json()).toMatchObject({ agent: { frozenAt: null }, revokedTokens: 1 });
    expect((await asAgent(alice.token, "/v1/agent/me")).status).toBe(401);
    const types = (await listLedger(alice.agent, { limit: 3 })).map((event) => event.type);
    expect(types).toEqual(["notice.received", "agent.unfrozen", "token.revoked"]);
  });
});

async function tokenIdOf(agentId: string): Promise<string> {
  const [row] = await db.select().from(agentTokens).where(eq(agentTokens.agentId, agentId));
  return row!.id;
}
