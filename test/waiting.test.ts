import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkInbox, sendMessage, waitForInbox } from "../src/domain/messaging.ts";
import { createApp } from "../src/http/app.ts";
import { createAgentWithToken, startServer } from "./helpers.ts";

const app = createApp();

async function later<T>(ms: number, action: () => Promise<T>): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return action();
}

async function pair() {
  const alice = await createAgentWithToken("alice_agent");
  const bob = await createAgentWithToken("bob_agent");
  return { alice, bob };
}

describe("waiting for messages", () => {
  it("returns messages that are already waiting without blocking", async () => {
    const { alice, bob } = await pair();
    await sendMessage(alice.agent, { to: "@bob_agent", body: "Already here" });

    const started = Date.now();
    const inbox = await waitForInbox(bob.agent, 30);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(inbox.threads[0]?.messages.map((m) => m.body)).toEqual(["Already here"]);
  });

  it("wakes up as soon as a message arrives", async () => {
    const { alice, bob } = await pair();

    const started = Date.now();
    const [inbox] = await Promise.all([
      waitForInbox(bob.agent, 30),
      later(300, () => sendMessage(alice.agent, { to: "@bob_agent", body: "Are you there?" })),
    ]);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(inbox.threads[0]?.messages.map((m) => m.body)).toEqual(["Are you there?"]);
  });

  it("gives up with an empty inbox after the timeout", async () => {
    const { bob } = await pair();
    const started = Date.now();
    const inbox = await waitForInbox(bob.agent, 1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(inbox.threads).toEqual([]);
  });

  it("stops when the caller goes away", async () => {
    const { bob } = await pair();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const started = Date.now();
    const inbox = await waitForInbox(bob.agent, 30, { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(inbox.threads).toEqual([]);
  });

  it("long-polls the REST inbox", async () => {
    const { alice, bob } = await pair();
    const headers = { authorization: `Bearer ${bob.token}` };

    const tooLong = await app.request("/v1/agent/inbox?wait=120", { headers });
    expect(tooLong.status).toBe(400);

    const [response] = await Promise.all([
      app.request("/v1/agent/inbox?wait=30", { headers }),
      later(300, () => sendMessage(alice.agent, { to: "@bob_agent", body: "Over REST" })),
    ]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { threads: { messages: { body: string }[] }[] };
    expect(body.threads[0]?.messages.map((m) => m.body)).toEqual(["Over REST"]);
  });

  it("replays the inbox from a cursor until the agent moves past it", async () => {
    const { alice, bob } = await pair();
    const headers = { authorization: `Bearer ${bob.token}` };
    type Body = { threads: { messages: { body: string }[] }[]; cursor: number };
    const read = async (query: string) => {
      const response = await app.request(`/v1/agent/inbox?${query}`, { headers });
      return (await response.json()) as Body;
    };
    const bodies = (inbox: Body) => inbox.threads.flatMap((t) => t.messages.map((m) => m.body));

    const start = await read("");
    await sendMessage(alice.agent, { to: "@bob_agent", body: "First" });
    const first = await read(`since=${start.cursor}`);
    expect(bodies(first)).toEqual(["First"]);
    expect(bodies(await read(`since=${start.cursor}`))).toEqual(["First"]);
    expect(bodies(await read(`since=${first.cursor}`))).toEqual([]);
    expect((await checkInbox(bob.agent)).threads).toEqual([]);

    const [waited] = await Promise.all([
      read(`since=${first.cursor}&wait=30`),
      later(300, () => sendMessage(alice.agent, { to: "@bob_agent", body: "Second" })),
    ]);
    expect(bodies(waited)).toEqual(["Second"]);
    expect(waited.cursor).toBeGreaterThan(first.cursor);
  });

  describe("over MCP", () => {
    let server: Awaited<ReturnType<typeof startServer>>;

    beforeAll(async () => {
      server = await startServer();
    });

    afterAll(async () => {
      await server.close();
    });

    it("lets an agent wait for a reply", async () => {
      const { alice, bob } = await pair();
      const client = new Client({ name: "callsign-test", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`/mcp/${bob.token}`, server.url)),
      );

      const [result] = await Promise.all([
        client.callTool({ name: "wait_for_reply", arguments: { seconds: 30 } }),
        later(300, () => sendMessage(alice.agent, { to: "@bob_agent", body: "Reply soon" })),
      ]);
      const [first] = result.content as { text?: string }[];
      expect(first?.text).toContain("Reply soon");

      const empty = await client.callTool({ name: "wait_for_reply", arguments: { seconds: 1 } });
      const [none] = empty.content as { text?: string }[];
      expect(none?.text).toContain("No new messages arrived while waiting.");
      await client.close();
    });
  });
});
