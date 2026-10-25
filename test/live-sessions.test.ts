import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import type { Owner } from "../src/db/schema.ts";
import { createGroup, respondToGroupInvite } from "../src/domain/groups.ts";
import { listLedger } from "../src/domain/ledger.ts";
import {
  endLiveSession,
  getLiveSession,
  recordLiveSessionEvents,
  startLiveSession,
  takeOverLiveSession,
} from "../src/domain/live-sessions.ts";
import { checkInbox } from "../src/domain/messaging.ts";
import { createSession } from "../src/domain/owners.ts";
import { createApp } from "../src/http/app.ts";
import { createAgentWithToken, startServer } from "./helpers.ts";

const app = createApp();

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.close();
});

async function connect(token: string) {
  const client = new Client({ name: "live-sessions-test", version: "1.0.0" });
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
  return { text: first?.text ?? "", data: result.structuredContent as Record<string, unknown> };
}

async function ownerHeaders(owner: Owner) {
  const { sessionToken } = await createSession(db, owner.id);
  return {
    cookie: `callsign_session=${sessionToken}`,
    "content-type": "application/json",
    origin: "http://localhost:3001",
  };
}

// Tomás and Mateo work together in #socios; Bruno is outside it.
async function team() {
  const tomas = await createAgentWithToken("tomas_agent");
  const mateo = await createAgentWithToken("mateo_agent");
  const bruno = await createAgentWithToken("bruno_agent");
  await createGroup(tomas.agent, { name: "#socios", members: ["@mateo_agent"] });
  await respondToGroupInvite(mateo.agent, "#socios", "accept", "agent");
  return { tomas, mateo, bruno };
}

describe("live sessions", () => {
  it("records the driver's steps for everyone in the group to watch", async () => {
    const { tomas, mateo, bruno } = await team();
    const session = await startLiveSession(
      tomas.agent,
      { title: "Migrate the billing tables", group: "#socios" },
      "Claude Code",
    );
    await recordLiveSessionEvents(tomas.agent, session.id, [
      { kind: "tool", text: "Read billing/models.py" },
      { kind: "step", text: "Plan: drop the phone column" },
    ]);

    const seen = await getLiveSession(mateo.agent, session.id);
    expect(seen).toMatchObject({
      title: "Migrate the billing tables",
      status: "live",
      driver: "@tomas_agent",
      group: "#socios",
      client: "Claude Code",
    });
    expect(seen.events.map((event) => [event.kind, event.text])).toEqual([
      ["status", "@tomas_agent started the session in Claude Code."],
      ["tool", "Read billing/models.py"],
      ["step", "Plan: drop the phone column"],
    ]);
    const after = await getLiveSession(mateo.agent, session.id, { after: 2 });
    expect(after.events.map((event) => event.seq)).toEqual([3]);

    await expect(getLiveSession(bruno.agent, session.id)).rejects.toThrow(/no such live session/);
    await expect(
      startLiveSession(bruno.agent, { title: "Snoop", group: "#socios" }, null),
    ).rejects.toThrow(/not a member of #socios/);
  });

  it("delivers a teammate's correction from the dashboard to the driver", async () => {
    const { tomas, mateo } = await team();
    const session = await startLiveSession(
      tomas.agent,
      { title: "Migrate the billing tables", group: "#socios" },
      null,
    );

    const res = await app.request(`/v1/agents/mateo_agent/sessions/${session.id}/steer`, {
      method: "POST",
      headers: await ownerHeaders(mateo.owner),
      body: JSON.stringify({ text: "Wait, the mobile app still reads phone." }),
    });
    expect(res.status).toBe(200);

    const { steers } = await recordLiveSessionEvents(tomas.agent, session.id, [
      { kind: "step", text: "Writing the migration" },
    ]);
    expect(steers).toHaveLength(1);
    expect(steers[0]?.text).toBe(
      'The person behind @mateo_agent, watching your live session "Migrate the billing tables" in #socios, says: Wait, the mobile app still reads phone.',
    );
    expect((await checkInbox(tomas.agent)).notices).toEqual([]);

    const timeline = await getLiveSession(tomas.agent, session.id);
    expect(timeline.events.find((event) => event.kind === "steer")).toMatchObject({
      by: "@mateo_agent",
      fromOwner: true,
      text: "Wait, the mobile app still reads phone.",
    });
    const mateoLedger = await listLedger(mateo.agent, { limit: 5 });
    expect(mateoLedger.map((entry) => entry.type)).toContain("session.steered");
  });

  it("lets the driver's own owner steer, and shows it in the inbox when no step comes", async () => {
    const { tomas } = await team();
    const session = await startLiveSession(tomas.agent, { title: "Invoice run" }, null);
    const res = await app.request(`/v1/agents/tomas_agent/sessions/${session.id}/steer`, {
      method: "POST",
      headers: await ownerHeaders(tomas.owner),
      body: JSON.stringify({ text: "Skip the Acme invoices today." }),
    });
    expect(res.status).toBe(200);

    const inbox = await checkInbox(tomas.agent);
    expect(inbox.notices.map((notice) => [notice.kind, notice.sessionId, notice.text])).toEqual([
      [
        "session.steer",
        session.id,
        'Your owner, watching your live session "Invoice run", says: Skip the Acme invoices today.',
      ],
    ]);
  });

  it("hands the session to a teammate's agent and stops the previous driver", async () => {
    const { tomas, mateo, bruno } = await team();
    const session = await startLiveSession(
      tomas.agent,
      { title: "Migrate the billing tables", group: "#socios" },
      null,
    );
    await expect(takeOverLiveSession(bruno.agent, session.id)).rejects.toThrow(
      /no such live session/,
    );

    const taken = await takeOverLiveSession(mateo.agent, session.id);
    expect(taken.driver).toBe("@mateo_agent");
    expect(taken.events.at(-1)?.text).toBe("@mateo_agent took over from @tomas_agent.");

    await expect(
      recordLiveSessionEvents(tomas.agent, session.id, [{ kind: "step", text: "Still here" }]),
    ).rejects.toThrow(/Someone else is driving/);
    const notices = (await checkInbox(tomas.agent)).notices;
    expect(notices.map((notice) => notice.kind)).toEqual(["session.taken_over"]);

    await recordLiveSessionEvents(mateo.agent, session.id, [
      { kind: "step", text: "Kept phone, added phone_number" },
    ]);
    const ended = await endLiveSession(mateo.agent, session.id, {
      summary: "Migration done, phone kept for mobile.",
      next: "Drop phone after the app release.",
    });
    expect(ended.status).toBe("ended");
    expect(ended.events.slice(-2).map((event) => [event.kind, event.text])).toEqual([
      [
        "handoff",
        "Migration done, phone kept for mobile.\nNext: Drop phone after the app release.",
      ],
      ["status", "@mateo_agent ended the session."],
    ]);
    await expect(
      recordLiveSessionEvents(mateo.agent, session.id, [{ kind: "step", text: "One more" }]),
    ).rejects.toThrow(/has ended/);
  });

  it("opens from a shared link for anyone who can watch it", async () => {
    const { tomas, mateo, bruno } = await team();
    const session = await startLiveSession(
      tomas.agent,
      { title: "Migrate the billing tables", group: "#socios" },
      null,
    );

    const list = await app.request("/v1/sessions", { headers: await ownerHeaders(mateo.owner) });
    const { sessions } = (await list.json()) as { sessions: { id: string; driver: string }[] };
    expect(sessions).toEqual([expect.objectContaining({ id: session.id, driver: "@tomas_agent" })]);

    const opened = await app.request(`/v1/sessions/${session.id}`, {
      headers: await ownerHeaders(mateo.owner),
    });
    expect(await opened.json()).toMatchObject({
      through: "@mateo_agent",
      session: { id: session.id, title: "Migrate the billing tables" },
    });

    const steered = await app.request(`/v1/sessions/${session.id}/steer`, {
      method: "POST",
      headers: await ownerHeaders(mateo.owner),
      body: JSON.stringify({ text: "Keep phone for now." }),
    });
    expect(steered.status).toBe(200);
    expect((await checkInbox(tomas.agent)).notices[0]?.text).toContain(
      "The person behind @mateo_agent",
    );

    const stranger = await app.request(`/v1/sessions/${session.id}`, {
      headers: await ownerHeaders(bruno.owner),
    });
    expect(stranger.status).toBe(404);
  });

  it("works end to end over MCP", async () => {
    const { tomas, mateo } = await team();
    const tomasClient = await connect(tomas.token);
    const mateoClient = await connect(mateo.token);

    const started = await call(tomasClient, "start_session", {
      title: "Ship the Q4 launch",
      group: "#socios",
    });
    expect(started.text).toMatch(/Started the live session "Ship the Q4 launch"/);
    const id = (started.data.session as { id: string }).id;

    const update = await call(tomasClient, "session_update", {
      session: id,
      text: "Wrote the post",
    });
    expect(update.text).toBe("Recorded as #2.");

    const listed = await call(mateoClient, "get_session");
    expect(listed.text).toContain(
      `"Ship the Q4 launch" (session ${id}): live, driven by @tomas_agent`,
    );

    const taken = await call(mateoClient, "take_over_session", { session: id });
    expect(taken.text).toContain("#2 [step] @tomas_agent: Wrote the post");
    expect(taken.text).toContain("You're driving it now.");

    const ended = await call(mateoClient, "end_session", { session: id, summary: "Ads are live." });
    expect(ended.text).toBe('Ended the live session "Ship the Q4 launch" and left the handoff.');

    await tomasClient.close();
    await mateoClient.close();
  });
});
