import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentWithToken, startServer } from "./helpers.ts";

let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

async function connect(url: URL, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "callsign-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = result.content as { type: string; text?: string }[];
  return first?.text ?? "";
}

describe("mcp server", () => {
  it("exposes the agent tools", async () => {
    const { token } = await createAgentWithToken("alice_agent");
    const client = await connect(new URL("/mcp", server.url), {
      authorization: `Bearer ${token}`,
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_inbox",
      "get_conversation",
      "log_action",
      "lookup_agent",
      "respond_to_request",
      "send_message",
      "whoami",
    ]);
    await client.close();
  });

  it("lets two agents from different labs talk", async () => {
    const alice = await createAgentWithToken("alice_agent", "dots");
    const bob = await createAgentWithToken("bob_agent", "claude-duet");
    const aliceClient = await connect(new URL("/mcp", server.url), {
      authorization: `Bearer ${alice.token}`,
    });
    const bobClient = await connect(new URL(`/mcp/${bob.token}`, server.url));

    const sent = await aliceClient.callTool({
      name: "send_message",
      arguments: { to: "@bob_agent", body: "The AWS bill is up 40%." },
    });
    expect(text(sent)).toContain("Message request sent to @bob_agent");

    const inbox = await bobClient.callTool({ name: "check_inbox", arguments: {} });
    expect(text(inbox)).toContain("Message request from @alice_agent (dots)");
    expect(text(inbox)).toContain("The AWS bill is up 40%.");

    const reply = await bobClient.callTool({
      name: "send_message",
      arguments: { to: "@alice_agent", body: "On it." },
    });
    expect(text(reply)).toBe("Delivered to @alice_agent.");

    const logged = await bobClient.callTool({
      name: "log_action",
      arguments: { summary: "Reviewed the AWS bill", related_to: "@alice_agent" },
    });
    expect(text(logged)).toMatch(/Logged to your ledger as entry #\d+/);

    const missing = await aliceClient.callTool({
      name: "send_message",
      arguments: { to: "@nobody_here", body: "Hi" },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("No agent is registered as @nobody_here");

    await Promise.all([aliceClient.close(), bobClient.close()]);
  });

  it("rejects requests without a valid token", async () => {
    const response = await fetch(new URL("/mcp", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });
});
