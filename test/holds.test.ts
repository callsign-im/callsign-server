import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { agentNetworks, agents, files, heldActions, jobs, type Agent } from "../src/db/schema.ts";
import { createAgent } from "../src/domain/agents.ts";
import { uploadFile } from "../src/domain/files.ts";
import { expireHold } from "../src/domain/holds.ts";
import { checkInbox, sendMessage } from "../src/domain/messaging.ts";
import { createSession } from "../src/domain/owners.ts";
import type { Holds } from "../src/domain/policy.ts";
import { createApp } from "../src/http/app.ts";
import { createAgentWithToken, startServer } from "./helpers.ts";
import { elevate, enrollPasskey } from "./webauthn.ts";

const app = createApp();
let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

type Held = { status: string; holdId: string; reasons: string[] };

async function owned(handle: string, holds: Partial<Holds> = {}) {
  const created = await createAgentWithToken(handle);
  await db.update(agents).set({ policy: { holds } }).where(eq(agents.id, created.agent.id));
  const [agent] = await db.select().from(agents).where(eq(agents.id, created.agent.id));
  const { sessionToken } = await createSession(db, created.owner.id);
  return { ...created, agent: agent!, cookie: `callsign_session=${sessionToken}` };
}

function asAgent(token: string, path: string, body: unknown, ip = "203.0.113.7") {
  return app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

function dashboard(cookie: string, path: string, body?: unknown, method = "POST") {
  return app.request(path, {
    method,
    headers: { cookie, origin: "http://localhost:3001", "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function send(token: string, to: string, body: string, extra: object = {}) {
  const res = await asAgent(token, "/v1/agent/messages", { to, body, ...extra });
  return { status: res.status, body: (await res.json()) as Held & Record<string, unknown> };
}

async function inboxBodies(agent: Agent): Promise<string[]> {
  const inbox = await checkInbox(agent);
  return inbox.threads.flatMap((thread) => thread.messages.map((message) => message.body));
}

describe("held actions", () => {
  it("holds a first message to someone new over REST and MCP, never internal sends", async () => {
    const alice = await owned("alice_agent", { firstContact: true });
    const bob = await createAgentWithToken("bob_agent");

    const rest = await send(alice.token, "@bob_agent", "Hi Bob, can we talk pricing?");
    expect(rest.status).toBe(202);
    expect(rest.body).toMatchObject({ status: "held_for_approval", reasons: ["first_contact"] });
    expect(await inboxBodies(bob.agent)).toEqual([]);

    const client = new Client({ name: "holds-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
        requestInit: { headers: { authorization: `Bearer ${alice.token}` } },
      }),
    );
    const tool = await client.callTool({
      name: "send_message",
      arguments: { to: "@bob_agent", body: "Following up" },
    });
    expect(tool.isError).toBeFalsy();
    expect(tool.structuredContent).toMatchObject({
      status: "held_for_approval",
      reasons: ["first_contact"],
    });
    const [text] = tool.content as { text: string }[];
    expect(text?.text).toContain("Don't send it again");
    const whoami = await client.callTool({ name: "whoami", arguments: {} });
    expect(JSON.stringify(whoami.content)).toContain("2 of your actions are waiting");
    await client.close();

    await sendMessage(alice.agent, { to: "@bob_agent", body: "Sent by Callsign itself" });
    expect(await inboxBodies(bob.agent)).toEqual(["Sent by Callsign itself"]);
  });

  it("releases approved actions in order and tells the agent", async () => {
    const alice = await owned("alice_agent", { firstContact: true });
    const bob = await createAgentWithToken("bob_agent");
    const first = await send(alice.token, "@bob_agent", "First");
    const second = await send(alice.token, "@bob_agent", "Second");
    expect(second.body.reasons).toEqual(["first_contact"]);

    const early = await dashboard(alice.cookie, `/v1/holds/${second.body.holdId}`, {
      decision: "approve",
    });
    expect(await early.json()).toMatchObject({ hold: { status: "approved" } });
    expect(await inboxBodies(bob.agent)).toEqual([]);

    const approved = await dashboard(alice.cookie, `/v1/holds/${first.body.holdId}`, {
      decision: "approve",
    });
    expect(await approved.json()).toMatchObject({ hold: { status: "released" } });
    expect(await inboxBodies(bob.agent)).toEqual(["First", "Second"]);

    const notices = (await checkInbox(alice.agent)).notices;
    expect(notices.map((notice) => [notice.kind, notice.holdId])).toEqual([
      ["action.approved", first.body.holdId],
      ["action.approved", second.body.holdId],
    ]);
    expect(notices[0]?.text).toContain("It was sent to @bob_agent");

    const after = await send(alice.token, "@bob_agent", "Now we know each other");
    expect(after.status).toBe(201);
  });

  it("queues what follows a held action to the same place, even with the rule off", async () => {
    const alice = await owned("alice_agent", { firstContact: true });
    const bob = await createAgentWithToken("bob_agent");
    const first = await send(alice.token, "@bob_agent", "Opening line");
    await dashboard(
      alice.cookie,
      "/v1/agents/alice_agent/policy",
      { holds: { firstContact: false } },
      "PATCH",
    );
    const next = await send(alice.token, "@bob_agent", "Second line");
    expect(next.body.reasons).toEqual(["queued"]);
    await dashboard(alice.cookie, `/v1/holds/decide`, {
      ids: [first.body.holdId, next.body.holdId],
      decision: "approve",
    });
    expect(await inboxBodies(bob.agent)).toEqual(["Opening line", "Second line"]);
  });

  it("declines and expires holds, giving their files back", async () => {
    const alice = await owned("alice_agent", { attachments: true });
    await createAgentWithToken("bob_agent");
    const file = await uploadFile(alice.agent, {
      name: "quote.pdf",
      mimeType: "application/pdf",
      content: Buffer.from("%PDF-1.4"),
    });
    const held = await send(alice.token, "@bob_agent", "The quote", { attachments: [file.id] });
    expect(held.body.reasons).toEqual(["attachments"]);
    const [reserved] = await db.select().from(files).where(eq(files.id, file.id));
    expect(reserved?.heldActionId).toBe(held.body.holdId);
    const reused = await send(alice.token, "@bob_agent", "Again", { attachments: [file.id] });
    expect(reused.status).toBe(400);

    const denied = await dashboard(alice.cookie, `/v1/holds/${held.body.holdId}`, {
      decision: "deny",
    });
    expect(await denied.json()).toMatchObject({ hold: { status: "denied" } });
    const [freed] = await db.select().from(files).where(eq(files.id, file.id));
    expect(freed?.heldActionId).toBeNull();
    expect((await checkInbox(alice.agent)).notices.map((notice) => notice.kind)).toEqual([
      "action.denied",
    ]);

    const late = await send(alice.token, "@bob_agent", "One more", { attachments: [file.id] });
    await db
      .update(heldActions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(heldActions.id, late.body.holdId));
    await expireHold({ holdId: late.body.holdId });
    const [expired] = await db
      .select()
      .from(heldActions)
      .where(eq(heldActions.id, late.body.holdId));
    expect(expired?.status).toBe("expired");
    expect((await checkInbox(alice.agent)).notices.map((notice) => notice.kind)).toEqual([
      "action.expired",
    ]);
  });

  it("asks for the passkey to approve when the owner has one; links then only decline", async () => {
    const alice = await owned("alice_agent", { invitePerson: true });
    const passkey = await enrollPasskey(app, alice.cookie);
    const invite = async () =>
      (await (
        await asAgent(alice.token, "/v1/agent/invitations", { email: "maria@example.com" })
      ).json()) as Held;

    const held = await invite();
    expect(held.reasons).toEqual(["invite_person"]);
    const blocked = await dashboard(alice.cookie, `/v1/holds/${held.holdId}`, {
      decision: "approve",
    });
    expect(await blocked.json()).toMatchObject({ error: { code: "step_up_required" } });
    await elevate(app, alice.cookie, passkey);
    const approved = await dashboard(alice.cookie, `/v1/holds/${held.holdId}`, {
      decision: "approve",
    });
    expect(await approved.json()).toMatchObject({ hold: { status: "released" } });

    const other = await owned("bob_agent", { invitePerson: true });
    const second = (await (
      await asAgent(other.token, "/v1/agent/invitations", { email: "jose@example.com" })
    ).json()) as Held;
    const [notify] = (await db.select().from(jobs).where(eq(jobs.kind, "hold.notify"))).filter(
      (job) => job.payload.holdId === second.holdId,
    );
    const token = new URL(String(notify?.payload.approveUrl)).searchParams.get("token") ?? "";
    expect(await (await app.request(`/v1/hold-links/${token}`)).json()).toMatchObject({
      hold: {
        status: "pending",
        needsPasskey: false,
        summary: "Invite jose@example.com to Callsign",
      },
    });

    await enrollPasskey(app, other.cookie);
    const byLink = (decision: string) =>
      app.request(`/v1/hold-links/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
    const refused = await byLink("approve");
    expect(await refused.json()).toMatchObject({
      error: { code: "forbidden", details: { reason: "passkey_required" } },
    });
    expect(await (await byLink("deny")).json()).toMatchObject({ hold: { status: "denied" } });
  });

  it("holds by group, hourly limit and an unconfirmed network, and not while frozen", async () => {
    const alice = await owned("alice_agent", { groups: true, hourlyMessages: 1, newNetwork: true });
    await createAgent(alice.owner, { handle: "alice_helper", product: "custom" });
    await createAgentWithToken("bob_agent");

    const group = (await (
      await asAgent(alice.token, "/v1/agent/groups", {
        name: "#deal-room",
        members: ["@bob_agent"],
      })
    ).json()) as Held;
    expect(group.reasons).toEqual(["groups"]);

    expect((await send(alice.token, "@alice_helper", "One")).status).toBe(201);
    const over = await send(alice.token, "@alice_helper", "Two");
    expect(over.body.reasons).toEqual(["hourly_limit"]);

    await db.update(agents).set({ frozenAt: new Date() }).where(eq(agents.id, alice.agent.id));
    const frozen = await dashboard(alice.cookie, `/v1/holds/${over.body.holdId}`, {
      decision: "approve",
    });
    expect(frozen.status).toBe(409);
    await db.update(agents).set({ frozenAt: null }).where(eq(agents.id, alice.agent.id));

    await db.insert(agentNetworks).values({
      agentId: alice.agent.id,
      networkDigest: "baseline",
      label: { ciphertext: "v1.unused" },
      status: "known",
    });
    await db
      .update(agents)
      .set({ policy: { holds: { newNetwork: true } } })
      .where(eq(agents.id, alice.agent.id));
    const elsewhere = await send(alice.token, "@alice_helper", "From a café");
    expect(elsewhere.body.reasons).toEqual(["new_network"]);
  });

  it("asks for a passkey only to loosen the rules", async () => {
    const alice = await owned("alice_agent");
    const passkey = await enrollPasskey(app, alice.cookie);
    const patch = (body: unknown) =>
      dashboard(alice.cookie, "/v1/agents/alice_agent/policy", body, "PATCH");

    const tightened = await patch({ holds: { firstContact: true, hourlyMessages: 20 } });
    expect(await tightened.json()).toMatchObject({
      policy: { holds: { firstContact: true, hourlyMessages: 20 }, holdHours: 24 },
    });
    const loosened = await patch({ holds: { hourlyMessages: 50 } });
    expect(await loosened.json()).toMatchObject({ error: { code: "step_up_required" } });
    await elevate(app, alice.cookie, passkey);
    expect((await patch({ holds: { firstContact: false } })).status).toBe(200);

    const listed = (await (
      await app.request("/v1/agents/alice_agent", { headers: { cookie: alice.cookie } })
    ).json()) as { agent: { policy: { holds: Holds } } };
    expect(listed.agent.policy.holds).toMatchObject({ firstContact: false, hourlyMessages: 20 });
  });
});
