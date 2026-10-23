import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { jobs } from "../src/db/schema.ts";
import { deleteAgent } from "../src/domain/account.ts";
import { createAgent, createAgentToken } from "../src/domain/agents.ts";
import {
  createGroup,
  inviteToGroup,
  leaveGroup,
  listGroups,
  removeFromGroup,
  respondToGroupInvite,
} from "../src/domain/groups.ts";
import { checkInbox, getConversation, inboxSince, sendMessage } from "../src/domain/messaging.ts";
import { createApp } from "../src/http/app.ts";
import { createAgentWithToken, createOwner, startServer } from "./helpers.ts";

const app = createApp();

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.close();
});

async function connect(token: string) {
  const client = new Client({ name: "groups-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { text?: string }[];
  return first?.text ?? "";
}

async function trio() {
  const tomas = await createAgentWithToken("tomas_agent");
  const mateo = await createAgentWithToken("mateo_agent");
  const bruno = await createAgentWithToken("bruno_agent");
  return { tomas, mateo, bruno };
}

const bodies = (inbox: Awaited<ReturnType<typeof checkInbox>>) =>
  inbox.threads.flatMap((thread) => thread.messages.map((m) => `${m.from}: ${m.body}`));

describe("groups", () => {
  it("invites agents, who join once they accept", async () => {
    const { tomas, mateo, bruno } = await trio();
    const group = await createGroup(tomas.agent, {
      name: "#Launch-Team",
      members: ["@mateo_agent", "bruno_agent"],
      note: "Coordinating the ads launch.",
    });
    expect(group).toMatchObject({ name: "#launch-team", role: "admin", status: "active" });
    expect(group.members.map((m) => [m.handle, m.status])).toEqual([
      ["@tomas_agent", "active"],
      ["@mateo_agent", "invited"],
      ["@bruno_agent", "invited"],
    ]);

    const invitation = await checkInbox(mateo.agent);
    expect(invitation.threads[0]).toMatchObject({
      kind: "invitation",
      group: {
        name: "#launch-team",
        status: "invited",
        invitedBy: "@tomas_agent",
        note: "Coordinating the ads launch.",
      },
    });
    expect((await checkInbox(mateo.agent)).threads).toEqual([]);

    await sendMessage(tomas.agent, { to: "#launch-team", body: "Kickoff at 10" });
    await expect(sendMessage(mateo.agent, { to: "#launch-team", body: "Hi" })).rejects.toThrow(
      /Accept the invitation/,
    );

    await respondToGroupInvite(mateo.agent, "#launch-team", "accept", "agent");
    expect(bodies(await checkInbox(mateo.agent))).toEqual(["@tomas_agent: Kickoff at 10"]);

    const reply = await sendMessage(mateo.agent, {
      to: "#launch-team",
      body: "@tomas_agent on it",
    });
    expect(reply.status).toBe("delivered");
    const tomasInbox = await checkInbox(tomas.agent);
    expect(tomasInbox.threads[0]).toMatchObject({ kind: "message", mentioned: true, with: null });
    expect(bodies(tomasInbox)).toEqual(["@mateo_agent: @tomas_agent on it"]);
    expect(bodies(await checkInbox(bruno.agent))).toEqual([]);
  });

  it("adds the owner's other agents directly", async () => {
    const owner = await createOwner();
    const work = await createAgent(owner, { handle: "work_agent", product: "dots" });
    const home = await createAgent(owner, { handle: "home_agent", product: "muse" });
    const group = await createGroup(work, { name: "family", members: ["@home_agent"] });
    expect(group.members.find((m) => m.handle === "@home_agent")?.status).toBe("active");
    const inbox = await checkInbox(home);
    expect(inbox.threads[0]).toMatchObject({ kind: "invitation", group: { status: "active" } });
  });

  it("validates names, membership and size", async () => {
    const { tomas, mateo, bruno } = await trio();
    await expect(
      createGroup(tomas.agent, { name: "#a", members: ["@mateo_agent"] }),
    ).rejects.toThrow(/3 to 32/);
    await createGroup(tomas.agent, { name: "ops", members: ["@mateo_agent"] });
    await expect(
      createGroup(bruno.agent, { name: "#ops", members: ["@tomas_agent"] }),
    ).rejects.toThrow(/taken/);
    await expect(sendMessage(bruno.agent, { to: "#ops", body: "Let me in" })).rejects.toThrow(
      /not a member/,
    );
    await expect(sendMessage(bruno.agent, { to: "#nope", body: "Hi" })).rejects.toThrow(
      /no group called/,
    );
    const many = await Promise.all(
      Array.from({ length: 19 }, (_, i) => createAgentWithToken(`extra_${i}`)),
    );
    await expect(
      inviteToGroup(tomas.agent, "#ops", { handles: many.map((m) => m.agent.handle) }),
    ).rejects.toThrow(/up to 20/);
    expect(mateo).toBeDefined();
  });

  it("lets members leave, hands admin over and lets the admin remove members", async () => {
    const { tomas, mateo, bruno } = await trio();
    await createGroup(tomas.agent, { name: "ops", members: ["@mateo_agent", "@bruno_agent"] });
    await respondToGroupInvite(mateo.agent, "#ops", "accept", "agent");
    await respondToGroupInvite(bruno.agent, "#ops", "accept", "agent");

    await expect(removeFromGroup(mateo.agent, "#ops", "@bruno_agent")).rejects.toThrow(
      /Only the admin/,
    );
    await leaveGroup(tomas.agent, "#ops", "agent");
    expect((await listGroups(mateo.agent))[0]).toMatchObject({
      name: "#ops",
      role: "admin",
      members: 2,
    });

    await removeFromGroup(mateo.agent, "#ops", "@bruno_agent");
    await expect(sendMessage(bruno.agent, { to: "#ops", body: "Still here?" })).rejects.toThrow(
      /not a member/,
    );
    expect(await listGroups(bruno.agent)).toEqual([]);
  });

  it("shows who read each message", async () => {
    const { tomas, mateo, bruno } = await trio();
    await createGroup(tomas.agent, { name: "ops", members: ["@mateo_agent", "@bruno_agent"] });
    await respondToGroupInvite(mateo.agent, "#ops", "accept", "agent");
    await respondToGroupInvite(bruno.agent, "#ops", "accept", "agent");
    const sent = await sendMessage(tomas.agent, { to: "#ops", body: "Budget is final" });
    await checkInbox(mateo.agent);

    const conversation = await getConversation(tomas.agent, "#ops", { limit: 10, markRead: true });
    expect(conversation.readBy.map((r) => [r.handle, r.seq >= sent.seq])).toEqual([
      ["@mateo_agent", true],
      ["@bruno_agent", false],
    ]);
  });

  it("caps how fast one agent can post, so agents can't loop", async () => {
    const { tomas, mateo } = await trio();
    await createGroup(tomas.agent, { name: "ops", members: ["@mateo_agent"] });
    for (let i = 0; i < 10; i++) {
      await sendMessage(tomas.agent, { to: "#ops", body: `update ${i}` });
    }
    await expect(sendMessage(tomas.agent, { to: "#ops", body: "one more" })).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(mateo).toBeDefined();
  });

  it("replays invitations and group messages from a cursor", async () => {
    const { tomas, mateo } = await trio();
    const start = (await checkInbox(mateo.agent)).cursor;
    await createGroup(tomas.agent, { name: "ops", members: ["@mateo_agent"] });
    await respondToGroupInvite(mateo.agent, "#ops", "accept", "agent");
    await sendMessage(tomas.agent, { to: "#ops", body: "First" });

    const replay = await inboxSince(mateo.agent, start);
    expect(replay.threads.map((t) => t.kind)).toEqual(["invitation"]);
    expect(bodies(replay)).toEqual(["@tomas_agent: First"]);
  });

  it("keeps the group when a member agent is deleted", async () => {
    const { tomas, mateo, bruno } = await trio();
    await createGroup(tomas.agent, { name: "ops", members: ["@mateo_agent", "@bruno_agent"] });
    await respondToGroupInvite(mateo.agent, "#ops", "accept", "agent");
    await respondToGroupInvite(bruno.agent, "#ops", "accept", "agent");
    await sendMessage(tomas.agent, { to: "#ops", body: "From Tomás" });
    await sendMessage(mateo.agent, { to: "#ops", body: "From Mateo" });

    await deleteAgent(tomas.agent);
    const conversation = await getConversation(bruno.agent, "#ops", { limit: 10, markRead: false });
    expect(conversation.messages.map((m) => m.body)).toEqual(["From Mateo"]);
    expect(conversation.group?.members.map((m) => [m.handle, m.role])).toEqual([
      ["@mateo_agent", "admin"],
      ["@bruno_agent", "member"],
    ]);
  });

  it("works over REST and notifies invitees' webhooks", async () => {
    const { tomas, mateo } = await trio();
    const { updateAgent } = await import("../src/domain/agents.ts");
    await updateAgent(mateo.agent, { webhookUrl: "https://hooks.example.com/mateo" });
    const auth = (token: string) => ({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });

    const created = await app.request("/v1/agent/groups", {
      method: "POST",
      headers: auth(tomas.token),
      body: JSON.stringify({ name: "ops", members: ["@mateo_agent"] }),
    });
    expect(created.status).toBe(201);
    const [job] = await db.select().from(jobs).where(eq(jobs.kind, "agent.webhook"));
    expect(job?.payload).toMatchObject({ kind: "invitation" });

    const accepted = await app.request("/v1/agent/groups/ops/invitation", {
      method: "POST",
      headers: auth(mateo.token),
      body: JSON.stringify({ decision: "accept" }),
    });
    expect(await accepted.json()).toMatchObject({ with: "#ops", status: "active" });

    await app.request("/v1/agent/messages", {
      method: "POST",
      headers: auth(tomas.token),
      body: JSON.stringify({ to: "#ops", body: "Over REST" }),
    });
    const history = await app.request("/v1/agent/groups/ops/messages", {
      headers: auth(mateo.token),
    });
    expect(await history.json()).toMatchObject({
      group: { name: "#ops" },
      messages: [{ from: "@tomas_agent", body: "Over REST" }],
    });
    const { token } = await createAgentToken(tomas.agent, "second");
    expect(token).toMatch(/^csk_/);
  });

  it("runs a group over MCP", async () => {
    const { tomas, mateo } = await trio();
    const tomasClient = await connect(tomas.token);
    const mateoClient = await connect(mateo.token);

    expect(
      await call(tomasClient, "create_group", {
        name: "#ops",
        members: ["@mateo_agent"],
        note: "Weekly sync",
      }),
    ).toContain("Created #ops");
    const invitation = await call(mateoClient, "check_inbox");
    expect(invitation).toContain("@tomas_agent invited you to the group #ops");
    expect(invitation).toContain("Weekly sync");

    expect(
      await call(mateoClient, "respond_to_request", { from: "#ops", decision: "accept" }),
    ).toContain("You accepted #ops");
    await call(tomasClient, "send_message", { to: "#ops", body: "@mateo_agent agenda?" });
    const inbox = await call(mateoClient, "check_inbox");
    expect(inbox).toContain("New messages in #ops (you were mentioned)");
    expect(await call(mateoClient, "list_groups")).toContain("#ops: 2 members");
    const history = await call(tomasClient, "get_conversation", { with: "#ops" });
    expect(history).toContain("read by @mateo_agent");
    await Promise.all([tomasClient.close(), mateoClient.close()]);
  });
});
