import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, gt } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { agents, eventSubscriptions, jobs, type Agent } from "../src/db/schema.ts";
import { listAgentTokens, revokeAgentToken, updateAgent } from "../src/domain/agents.ts";
import { createGroup, respondToGroupInvite } from "../src/domain/groups.ts";
import { checkInbox, sendMessage } from "../src/domain/messaging.ts";
import { standardSignature } from "../src/lib/crypto.ts";
import { wakeFields, wakeRequest, type WakeSettings } from "../src/domain/wake.ts";
import { processDueJobs } from "../src/jobs/runner.ts";
import { createAgentWithToken, startServer } from "./helpers.ts";

type Received = { headers: IncomingHttpHeaders; body: string };
type Reply = { status: number; body?: string };
type RpcResponse = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

let server: Awaited<ReturnType<typeof startServer>>;
const receivers: { close: () => void }[] = [];

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  for (const receiver of receivers.splice(0)) receiver.close();
});

async function receiver(reply: (body: string) => Reply = () => ({ status: 200 })) {
  const received: Received[] = [];
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      const { status, body: response } = reply(body);
      res.writeHead(status, { "content-type": "application/json" }).end(response ?? "");
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  receivers.push(http);
  const { port } = http.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/hooks`, received };
}

function echoChallenge(body: string): Reply {
  const parsed = JSON.parse(body) as { type?: string; challenge?: string };
  return parsed.type === "verification"
    ? { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) }
    : { status: 200 };
}

const newSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};

async function rpc(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  version: "2025-06-18" | "2026-07-28" = "2025-06-18",
) {
  const modern = version === "2026-07-28";
  const res = await fetch(new URL("/mcp", server.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": version,
      ...(modern && { "mcp-method": method }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: modern ? { ...params, _meta: MODERN_META } : params,
    }),
  });
  const text = await res.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice("data: ".length) : text) as RpcResponse;
}

async function agentApi(token: string, path: string) {
  const res = await fetch(new URL(path, server.url), {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as {
    notifications: { type: string; from: string | null; group: string | null }[];
    cursor: number;
    unread: number;
  };
}

async function setWake(agent: Agent, settings: WakeSettings) {
  return updateAgent(agent, { wake: await wakeFields(agent, settings) });
}

async function drainJobs() {
  while ((await processDueJobs()) > 0);
}

function verifies(delivery: Received | undefined, secret: string) {
  const id = String(delivery?.headers["webhook-id"]);
  const timestamp = Number(delivery?.headers["webhook-timestamp"]);
  return (
    delivery?.headers["webhook-signature"] ===
    standardSignature(secret, id, timestamp, delivery?.body ?? "")
  );
}

describe("notifications feed", () => {
  it("tells listeners what arrived without marking it read", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { agent: bob, token } = await createAgentWithToken("bob_agent");

    const start = await agentApi(token, "/v1/agent/notifications");
    expect(start).toMatchObject({ notifications: [], unread: 0 });

    await sendMessage(alice, { to: "@bob_agent", body: "Lunch on Friday?" });
    const feed = await agentApi(token, `/v1/agent/notifications?after=${start.cursor}`);
    expect(feed.unread).toBe(1);
    expect(feed.notifications).toEqual([
      expect.objectContaining({ type: "request.received", from: "@alice_agent", group: null }),
    ]);
    expect(JSON.stringify(feed)).not.toContain("Lunch");

    expect((await checkInbox(bob)).threads).toHaveLength(1);
    expect((await agentApi(token, "/v1/agent/notifications")).unread).toBe(0);
  });

  it("long-polls until something arrives", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { token } = await createAgentWithToken("bob_agent");
    const { cursor } = await agentApi(token, "/v1/agent/notifications");

    const started = Date.now();
    const waiting = agentApi(token, `/v1/agent/notifications?after=${cursor}&wait=10`);
    setTimeout(() => void sendMessage(alice, { to: "@bob_agent", body: "Ping" }), 300);
    const feed = await waiting;

    expect(feed.notifications).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("wake-ups", () => {
  it("validates where a wake-up can go", async () => {
    const { agent: bob } = await createAgentWithToken("bob_agent");
    await expect(
      wakeFields(bob, { kind: "claude", url: "https://example.com/fire", token: "x" }),
    ).rejects.toThrow(/fire URL/);
    await expect(
      wakeFields(bob, { kind: "grok", url: "https://example.com/hook", token: " " }),
    ).rejects.toThrow(/token/);
    const fields = await wakeFields(bob, {
      kind: "claude",
      url: "https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire",
      token: "Bearer sk-ant-oat01-secret",
    });
    expect(fields).toMatchObject({ wakeKind: "claude" });
  });

  it("calls Claude scheduled tasks the way their API expects", async () => {
    const { agent: bob } = await createAgentWithToken("bob_agent");
    const { headers, body } = wakeRequest(bob, "claude", "sk-ant-oat01-secret", {
      type: "request.received",
      agent: "@bob_agent",
      from: "@alice_agent",
      conversationId: "c",
      messageId: "m",
      sentAt: new Date().toISOString(),
    });
    expect(headers).toMatchObject({
      authorization: "Bearer sk-ant-oat01-secret",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "anthropic-version": "2023-06-01",
    });
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["text"]);
    expect(parsed.text).toContain("@alice_agent sent @bob_agent a message request");
    expect(parsed.text).toContain("check_inbox");
  });

  it("wakes a Grok Bot routine once per cooldown, without message contents", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { agent: bob } = await createAgentWithToken("bob_agent");
    const hook = await receiver();
    await setWake(bob, { kind: "grok", url: hook.url, token: "Bearer key-123" });

    await sendMessage(alice, { to: "@bob_agent", body: "Secret plans" });
    await sendMessage(alice, { to: "@bob_agent", body: "More secret plans" });
    await drainJobs();

    expect(hook.received).toHaveLength(1);
    const [wake] = hook.received;
    expect(wake?.headers.authorization).toBe("Bearer key-123");
    expect(JSON.parse(wake?.body ?? "{}")).toMatchObject({
      agent: "@bob_agent",
      from: "@alice_agent",
    });
    expect(wake?.body).not.toContain("Secret");

    const later = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, "agent.wake"), gt(jobs.runAt, new Date())));
    expect(later).toHaveLength(1);
    const [stored] = await db.select().from(agents).where(eq(agents.id, bob.id));
    expect(stored?.wakeStatus).toMatchObject({ ok: true, status: 200 });
  });

  it("doesn't wake an agent that already read its inbox", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { agent: bob } = await createAgentWithToken("bob_agent");
    const hook = await receiver();
    await setWake(bob, { kind: "webhook", url: hook.url });

    await sendMessage(alice, { to: "@bob_agent", body: "Hi" });
    await checkInbox(bob);
    await drainJobs();

    expect(hook.received).toHaveLength(0);
  });

  it("wakes group members only when a message mentions them", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { agent: bob } = await createAgentWithToken("bob_agent");
    await createGroup(alice, { name: "launch", members: ["@bob_agent"] });
    await respondToGroupInvite(bob, "#launch", "accept", "agent");
    await checkInbox(bob);
    await drainJobs();

    const hook = await receiver();
    await setWake(bob, { kind: "webhook", url: hook.url });
    await sendMessage(alice, { to: "#launch", body: "Deploy is green" });
    await drainJobs();
    expect(hook.received).toHaveLength(0);

    await sendMessage(alice, { to: "#launch", body: "@bob_agent can you tell the client?" });
    await drainJobs();
    expect(hook.received).toHaveLength(1);
    expect(JSON.parse(hook.received[0]?.body ?? "{}")).toMatchObject({
      group: "#launch",
      mentioned: true,
    });
  });
});

describe("MCP events", () => {
  it("advertises the events it can deliver", async () => {
    const { token } = await createAgentWithToken("bob_agent");
    const init = await rpc(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.result?.capabilities).toMatchObject({ events: {} });

    const discovered = await rpc(token, "server/discover", {}, "2026-07-28");
    expect(discovered.result?.capabilities).toMatchObject({ events: {} });

    const { result } = await rpc(token, "events/list", {}, "2026-07-28");
    const events = result?.events as { name: string; delivery: string[]; inputSchema: unknown }[];
    expect(events.map((e) => e.name)).toEqual(["message.received", "owner.answered"]);
    expect(events[0]).toMatchObject({
      delivery: ["webhook"],
      inputSchema: { type: "object", properties: { from: { type: "string" } } },
    });
  });

  it("verifies the callback, then delivers signed events without message contents", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { token } = await createAgentWithToken("bob_agent");
    const hook = await receiver(echoChallenge);
    const secret = newSecret();

    const subscribed = await rpc(token, "events/subscribe", {
      name: "message.received",
      arguments: {},
      delivery: { mode: "webhook", url: hook.url, secret },
      cursor: null,
      ttlMs: 3_600_000,
    });
    const id = String(subscribed.result?.id);
    expect(id).toMatch(/^sub_/);
    expect(subscribed.result).toMatchObject({ cursor: null, truncated: false });
    expect(Date.parse(String(subscribed.result?.refreshBefore))).toBeLessThanOrEqual(
      Date.now() + 3_600_000,
    );
    expect(hook.received).toHaveLength(1);
    expect(verifies(hook.received[0], secret)).toBe(true);

    await sendMessage(alice, { to: "@bob_agent", body: "Quarterly numbers attached" });
    await drainJobs();

    expect(hook.received).toHaveLength(2);
    const delivery = hook.received[1];
    const event = JSON.parse(delivery?.body ?? "{}") as Record<string, unknown>;
    expect(event).toMatchObject({
      name: "message.received",
      cursor: null,
      data: { kind: "request", agent: "@bob_agent", from: "@alice_agent", group: null },
    });
    expect(delivery?.headers["webhook-id"]).toBe(event.eventId);
    expect(delivery?.headers["x-mcp-subscription-id"]).toBe(id);
    expect(verifies(delivery, secret)).toBe(true);
    expect(delivery?.body).not.toContain("Quarterly");

    const refreshed = await rpc(token, "events/subscribe", {
      name: "message.received",
      arguments: {},
      delivery: { mode: "webhook", url: hook.url, secret },
    });
    expect(refreshed.result).toMatchObject({ id, deliveryStatus: { active: true } });
    expect(hook.received).toHaveLength(2);
  });

  it("refuses callbacks that don't echo the challenge", async () => {
    const { token } = await createAgentWithToken("bob_agent");
    const hook = await receiver();
    const response = await rpc(token, "events/subscribe", {
      name: "message.received",
      delivery: { mode: "webhook", url: hook.url, secret: newSecret() },
    });
    expect(response.error).toMatchObject({ code: -32015, data: { reason: "challenge_failed" } });
    expect(await db.select().from(eventSubscriptions)).toHaveLength(0);
  });

  it("rejects bad secrets and unknown events", async () => {
    const { token } = await createAgentWithToken("bob_agent");
    const hook = await receiver(echoChallenge);
    const badSecret = await rpc(token, "events/subscribe", {
      name: "message.received",
      delivery: { mode: "webhook", url: hook.url, secret: "whsec_c2hvcnQ=" },
    });
    expect(badSecret.error?.code).toBe(-32602);
    const unknown = await rpc(token, "events/subscribe", {
      name: "payment.received",
      delivery: { mode: "webhook", url: hook.url, secret: newSecret() },
    });
    expect(unknown.error?.code).toBe(-32011);
  });

  it("filters by sender and stops after unsubscribe or revocation", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { agent: bob, token } = await createAgentWithToken("bob_agent");
    const hook = await receiver(echoChallenge);
    const delivery = { mode: "webhook", url: hook.url, secret: newSecret() };

    await rpc(token, "events/subscribe", {
      name: "message.received",
      arguments: { from: "@carol_agent" },
      delivery,
    });
    await sendMessage(alice, { to: "@bob_agent", body: "Hi" });
    await drainJobs();
    expect(hook.received).toHaveLength(1);

    const removed = await rpc(token, "events/unsubscribe", {
      name: "message.received",
      arguments: { from: "@carol_agent" },
      delivery: { mode: "webhook", url: hook.url },
    });
    expect(removed.result).toEqual({});
    expect(await db.select().from(eventSubscriptions)).toHaveLength(0);

    await rpc(token, "events/subscribe", { name: "message.received", delivery });
    expect(await db.select().from(eventSubscriptions)).toHaveLength(1);
    const [credential] = await listAgentTokens(bob.id);
    await revokeAgentToken(bob, String(credential?.id));
    expect(await db.select().from(eventSubscriptions)).toHaveLength(0);
  });
});
