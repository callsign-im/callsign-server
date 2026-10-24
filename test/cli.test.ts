import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../cli/src/api.ts";
import { serveChannel } from "../cli/src/channel.ts";
import { commandFor, listen, splitCommand } from "../cli/src/listen.ts";
import { createGroup, respondToGroupInvite } from "../src/domain/groups.ts";
import { checkInbox, sendMessage } from "../src/domain/messaging.ts";
import { createPlan } from "../src/domain/plans.ts";
import { createAgentWithToken, startServer } from "./helpers.ts";

let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

const quiet = () => undefined;

async function until(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("callsign listen", () => {
  it("handles what's waiting and exits with --once", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { token } = await createAgentWithToken("bob_agent");
    const client = createClient(server.url, token);
    const prompts: string[] = [];
    const run = (prompt: string) => {
      prompts.push(prompt);
      return Promise.resolve(0);
    };
    const options = { client, groups: "mentions" as const, log: quiet, once: true, run };

    await listen({ ...options, signal: new AbortController().signal });
    expect(prompts).toHaveLength(0);

    await sendMessage(alice, { to: "@bob_agent", body: "Are we still on for Friday?" });
    await listen({ ...options, signal: new AbortController().signal });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("as @bob_agent: you have 1 unread item");
    expect(prompts[0]).toContain("check_inbox");
    expect(prompts[0]).not.toContain("Friday");
  });

  it("starts the agent when a message arrives, skipping group chatter", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { agent: bob, token } = await createAgentWithToken("bob_agent");
    await createGroup(alice, { name: "launch", members: ["@bob_agent"] });
    await respondToGroupInvite(bob, "#launch", "accept", "agent");
    await checkInbox(bob);

    const prompts: string[] = [];
    const controller = new AbortController();
    const listening = listen({
      client: createClient(server.url, token),
      groups: "mentions",
      log: quiet,
      once: false,
      signal: controller.signal,
      waitSeconds: 1,
      settleMs: 0,
      run: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(0);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    await sendMessage(alice, { to: "#launch", body: "Deploy is green" });
    await sendMessage(alice, { to: "@bob_agent", body: "Can you call me?" });
    await until(() => prompts.length > 0);
    controller.abort();
    await listening;

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("@alice_agent sent you a message");
    expect(prompts[0]).not.toContain("#launch");
  });

  it("starts the agent when someone shares a plan with it", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { agent: bob, token } = await createAgentWithToken("bob_agent");
    await sendMessage(alice, { to: "@bob_agent", body: "Plan?" });
    await sendMessage(bob, { to: "@alice_agent", body: "Yes" });
    await checkInbox(bob);

    const prompts: string[] = [];
    const controller = new AbortController();
    const listening = listen({
      client: createClient(server.url, token),
      groups: "mentions",
      log: quiet,
      once: false,
      signal: controller.signal,
      waitSeconds: 1,
      settleMs: 0,
      run: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(0);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await createPlan(alice, {
      with: "@bob_agent",
      title: "Launch",
      tasks: [{ title: "Ads", assignee: "@bob_agent" }],
    });
    await until(() => prompts.length > 0);
    controller.abort();
    await listening;
    expect(prompts[0]).toContain("@alice_agent shared a plan with you");
  });

  it("builds the agent command", () => {
    const claude = commandFor({ preset: "claude", serverName: "callsign", resume: true });
    expect(claude("hi")).toEqual([
      "claude",
      "-p",
      "hi",
      "--allowedTools",
      "mcp__callsign",
      "--continue",
    ]);
    expect(commandFor({ preset: "codex", serverName: "callsign", resume: false })("hi")).toEqual([
      "codex",
      "exec",
      "--skip-git-repo-check",
      "hi",
    ]);
    expect(commandFor({ command: "my-agent --task {prompt} --fast" })("hi")).toEqual([
      "my-agent",
      "--task",
      "hi",
      "--fast",
    ]);
    expect(splitCommand(`run "two words" 'and more'`)).toEqual(["run", "two words", "and more"]);
  });
});

describe("callsign channel", () => {
  it("pushes Callsign activity into a Claude Code session", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { token } = await createAgentWithToken("bob_agent");
    const input = new PassThrough();
    const output = new PassThrough();
    const messages: Record<string, unknown>[] = [];
    createInterface({ input: output }).on("line", (line) => {
      messages.push(JSON.parse(line) as Record<string, unknown>);
    });
    const controller = new AbortController();
    const serving = serveChannel({
      client: createClient(server.url, token),
      groups: "mentions",
      log: quiet,
      signal: controller.signal,
      waitSeconds: 1,
      version: "test",
      input,
      output,
    });

    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } })}\n`,
    );
    await until(() => messages.length > 0);
    expect(messages[0]).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { experimental: { "claude/channel": {} } },
      },
    });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await sendMessage(alice, { to: "@bob_agent", body: "Invoice attached" });
    await until(() => messages.length > 1);
    controller.abort();
    await serving;

    expect(messages[1]).toMatchObject({
      method: "notifications/claude/channel",
      params: {
        content:
          "@alice_agent sent you a message request on Callsign. Call check_inbox to read it.",
        meta: { kind: "request", from: "@alice_agent" },
      },
    });
  });
});
