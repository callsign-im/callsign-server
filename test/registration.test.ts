import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "../src/db/client.ts";
import { jobs } from "../src/db/schema.ts";
import { createApp } from "../src/http/app.ts";
import { processDueJobs } from "../src/jobs/runner.ts";
import { createAgentWithToken, startServer } from "./helpers.ts";

const app = createApp();

function json(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function register(handle = "brunoagent", ownerEmail = "bruno@example.com") {
  const response = await json("POST", "/v1/register", {
    handle,
    ownerEmail,
    product: "grok-bot",
    description: "Bruno's assistant for sales follow-ups",
    notifyEmail: "bruno@mail.grokbot.com",
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { token: string; status: string; next: string[] };
}

async function approvalToken(): Promise<string> {
  const [job] = await db.select().from(jobs).where(eq(jobs.kind, "email.approval"));
  const url = new URL(String(job?.payload.url));
  return url.searchParams.get("token") ?? "";
}

describe("agent self-registration", () => {
  it("issues a token that works once the owner approves by email", async () => {
    const registered = await register();
    expect(registered.status).toBe("pending_approval");
    expect(registered.token).toMatch(/^csk_/);
    expect(registered.next.join(" ")).toContain("b***@example.com");

    const auth = { authorization: `Bearer ${registered.token}` };
    const blocked = await json("GET", "/v1/agent/inbox", undefined, auth);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: { code: "pending_approval" } });

    const status = await json("GET", "/v1/register/status", undefined, auth);
    expect(await status.json()).toMatchObject({ status: "pending_approval" });

    const taken = await json("GET", "/v1/handles/brunoagent");
    expect(await taken.json()).toMatchObject({ status: "taken" });

    const token = await approvalToken();
    const preview = await app.request(`/v1/registrations/claim?token=${token}`);
    expect(await preview.json()).toMatchObject({
      handle: "@brunoagent",
      ownerEmail: "bruno@example.com",
    });

    const approved = await json("POST", "/v1/registrations/claim", { token, decision: "approve" });
    expect(approved.status).toBe(200);
    expect(approved.headers.get("set-cookie")).toContain("callsign_session=");
    expect(await approved.json()).toMatchObject({
      status: "approved",
      agent: {
        handle: "@brunoagent",
        description: "Bruno's assistant for sales follow-ups",
        primary: true,
        notifyEmail: "bruno@mail.grokbot.com",
      },
    });

    const active = await json("GET", "/v1/register/status", undefined, auth);
    expect(await active.json()).toMatchObject({ status: "active" });
    const inbox = await json("GET", "/v1/agent/inbox", undefined, auth);
    expect(inbox.status).toBe(200);

    const reuse = await json("POST", "/v1/registrations/claim", { token, decision: "approve" });
    expect(reuse.status).toBe(404);
  });

  it("releases the handle when the owner rejects", async () => {
    const { token } = await register();
    await json("POST", "/v1/registrations/claim", {
      token: await approvalToken(),
      decision: "reject",
    });
    const status = await json("GET", "/v1/register/status", undefined, {
      authorization: `Bearer ${token}`,
    });
    expect(status.status).toBe(401);
    const available = await json("GET", "/v1/handles/brunoagent");
    expect(await available.json()).toMatchObject({ status: "available" });
  });

  it("releases the handle after the request expires", async () => {
    await register();
    await sql`update agent_registrations set expires_at = now() - interval '1 minute'`;
    const again = await register("brunoagent", "someone-else@example.com");
    expect(again.status).toBe("pending_approval");
  });

  it("refuses handles that are taken or awaiting approval", async () => {
    await createAgentWithToken("takenagent");
    const taken = await json("POST", "/v1/register", {
      handle: "takenagent",
      ownerEmail: "a@example.com",
    });
    expect(taken.status).toBe(409);

    await register();
    const duplicate = await json("POST", "/v1/register", {
      handle: "brunoagent",
      ownerEmail: "b@example.com",
    });
    expect(duplicate.status).toBe(409);
  });

  it("emails the approval link", async () => {
    await register("mailagent", `owner-${Date.now()}@example.com`);
    expect(await processDueJobs()).toBe(1);
  });

  it("lets a signed-in owner approve from the dashboard", async () => {
    await register();
    await json("POST", "/v1/auth/login", { email: "bruno@example.com" });
    const [login] = await db.select().from(jobs).where(eq(jobs.kind, "email.login"));
    const loginToken = new URL(String(login?.payload.url)).searchParams.get("token");
    const verified = await json("POST", "/v1/auth/verify", { token: loginToken });
    const cookie = verified.headers.get("set-cookie")?.split(";")[0] ?? "";

    const list = await json("GET", "/v1/registrations", undefined, { cookie });
    const { registrations } = (await list.json()) as { registrations: { id: string }[] };
    expect(registrations).toHaveLength(1);

    const decided = await json(
      "POST",
      `/v1/registrations/${registrations[0]?.id}`,
      { decision: "approve" },
      { cookie },
    );
    expect(await decided.json()).toMatchObject({ status: "approved" });
    const agents = await json("GET", "/v1/agents", undefined, { cookie });
    expect(await agents.json()).toMatchObject({ agents: [{ handle: "@brunoagent" }] });
  });
});

describe("self-registration over MCP", () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("explains the pending state to MCP clients and connects after approval", async () => {
    const { token } = await register();
    const url = new URL(`/mcp/${token}`, server.url);

    const pending = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(pending.status).toBe(403);
    expect(JSON.stringify(await pending.json())).toContain("waiting for its owner to approve");

    await json("POST", "/v1/registrations/claim", {
      token: await approvalToken(),
      decision: "approve",
    });
    const client = new Client({ name: "grok-bot", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(JSON.stringify(result.content)).toContain("@brunoagent");
    await client.close();
  });
});
