import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { and, eq, sql as where } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, sql } from "../src/db/client.ts";
import { agents, jobs, securityAlerts } from "../src/db/schema.ts";
import { listLedger } from "../src/domain/ledger.ts";
import { createApp } from "../src/http/app.ts";
import { startServer } from "./helpers.ts";

const CIMD_CLIENT = "https://client.example.com/oauth/metadata.json";

vi.mock("../src/lib/safe-fetch.ts", () => ({
  fetchPublicJson: vi.fn((url: URL) =>
    Promise.resolve({
      body: {
        client_id: url.toString(),
        client_name: "Example Desktop",
        redirect_uris: ["http://127.0.0.1:7777/callback"],
      },
      maxAge: 600,
    }),
  ),
}));

const app = createApp();
const origin = "http://localhost:3001";
const redirectUri = "http://127.0.0.1:33418/callback";
const resource = "http://localhost:8080/mcp";

type Tokens = { access_token: string; refresh_token: string; expires_in: number; scope: string };

let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

async function signIn(email: string): Promise<string> {
  await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email }),
  });
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "email.login"), where`${jobs.payload}->>'email' = ${email}`));
  const token = new URL(String(job?.payload.url)).searchParams.get("token");
  const response = await app.request("/v1/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token }),
  });
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(body: Record<string, unknown> = {}) {
  const response = await app.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [redirectUri], ...body }),
  });
  return { response, client: (await response.json()) as Record<string, unknown> };
}

async function authorize(clientId: string, overrides: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    resource,
    ...overrides,
  });
  const response = await app.request(`/oauth/authorize?${query.toString()}`);
  const location = response.headers.get("location");
  const nonce = /callsign_oauth=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  return {
    response,
    verifier,
    location: location ? new URL(location) : null,
    requestId: location ? new URL(location).searchParams.get("request") : null,
    nonce,
  };
}

function consent(
  method: "GET" | "POST",
  requestId: string,
  cookies: string[],
  body?: Record<string, unknown>,
) {
  return app.request(`/v1/oauth/requests/${requestId}`, {
    method,
    headers: { "content-type": "application/json", origin, cookie: cookies.join("; ") },
    ...(body && { body: JSON.stringify(body) }),
  });
}

function token(params: Record<string, string>) {
  return app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

async function connect(email = "owner@example.com") {
  const session = await signIn(email);
  const { client } = await register();
  const clientId = String(client.client_id);
  const started = await authorize(clientId);
  const requestId = started.requestId ?? "";
  const approved = await consent("POST", requestId, [session, `callsign_oauth=${started.nonce}`], {
    decision: "approve",
    create: {
      handle: "claude_code_agent",
      description: "Tomás's coding agent.",
      product: "custom",
      rules: "Share code reviews with my organization only.",
    },
  });
  const { redirectTo } = (await approved.json()) as { redirectTo: string };
  const callback = new URL(redirectTo);
  const code = callback.searchParams.get("code") ?? "";
  const exchanged = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: started.verifier,
    resource,
  });
  return { session, clientId, code, verifier: started.verifier, callback, exchanged };
}

async function mcpWhoami(accessToken: string) {
  const client = new Client({ name: "oauth-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  const result = await client.callTool({ name: "whoami", arguments: {} });
  await client.close();
  const [first] = result.content as { text?: string }[];
  return first?.text ?? "";
}

async function mcpStatus(accessToken: string) {
  const response = await fetch(new URL("/mcp", server.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return response.status;
}

describe("oauth for mcp clients", () => {
  it("publishes protected resource and authorization server metadata", async () => {
    const resourceMetadata = await app.request("/.well-known/oauth-protected-resource/mcp");
    expect(await resourceMetadata.json()).toMatchObject({
      resource,
      authorization_servers: ["http://localhost:8080"],
      scopes_supported: ["agent"],
    });
    const metadata = await app.request("/.well-known/oauth-authorization-server");
    expect(await metadata.json()).toMatchObject({
      issuer: "http://localhost:8080",
      authorization_endpoint: "http://localhost:8080/oauth/authorize",
      token_endpoint: "http://localhost:8080/oauth/token",
      registration_endpoint: "http://localhost:8080/oauth/register",
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("validates dynamic client registrations", async () => {
    const remote = await register({ redirect_uris: ["http://evil.example.com/callback"] });
    expect(remote.response.status).toBe(400);
    expect(remote.client).toMatchObject({ error: "invalid_redirect_uri" });

    const fragment = await register({ redirect_uris: ["https://app.example.com/cb#x"] });
    expect(fragment.client).toMatchObject({ error: "invalid_redirect_uri" });

    const script = await register({ redirect_uris: ["javascript:alert(1)"] });
    expect(script.client).toMatchObject({ error: "invalid_redirect_uri" });

    const app_ = await register({
      redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/callback"],
    });
    expect(app_.response.status).toBe(201);
    expect(app_.client).toMatchObject({ token_endpoint_auth_method: "none" });
    expect(app_.client).not.toHaveProperty("client_secret");
  });

  it("connects a client end to end and lets it use MCP without handling a token", async () => {
    const { session, callback, exchanged } = await connect();
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("state-123");
    expect(callback.searchParams.get("iss")).toBe("http://localhost:8080");
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get("cache-control")).toBe("no-store");
    const tokens = (await exchanged.json()) as Tokens;
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "agent" });
    expect(tokens.refresh_token).toMatch(/^csr_/);

    const whoami = await mcpWhoami(tokens.access_token);
    expect(whoami).toContain("@claude_code_agent");
    expect(whoami).toContain("Share code reviews with my organization only.");

    const list = await app.request("/v1/agents/claude_code_agent/tokens", {
      headers: { cookie: session },
    });
    expect(await list.json()).toMatchObject({ tokens: [{ name: "Claude Code", kind: "oauth" }] });
  });

  it("rotates refresh tokens and revokes the grant when an old one comes back", async () => {
    const { clientId, exchanged } = await connect();
    const first = (await exchanged.json()) as Tokens;

    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as Tokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await mcpStatus(first.access_token)).toBe(401);
    expect(await mcpStatus(second.access_token)).toBe(200);

    const replayed = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(await replayed.json()).toMatchObject({ error: "invalid_grant" });
    expect(await mcpStatus(second.access_token)).toBe(401);

    const [agent] = await db.select().from(agents);
    const [alerted, revoked] = await listLedger(agent!, { limit: 2 });
    expect(revoked).toMatchObject({
      type: "token.revoked",
      actor: "system",
      data: { reason: "refresh_token_reused" },
    });
    expect(alerted).toMatchObject({
      type: "security.alert",
      data: { kind: "refresh_token_reused" },
    });
    expect(await db.select().from(securityAlerts)).toMatchObject([
      { kind: "refresh_token_reused", status: "open" },
    ]);
  });

  it("refuses to refresh a frozen agent's tokens without revoking them", async () => {
    const { clientId, exchanged } = await connect();
    const first = (await exchanged.json()) as Tokens;
    await db.update(agents).set({ frozenAt: new Date() });
    const refused = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(await refused.json()).toMatchObject({ error: "invalid_grant" });

    await db.update(agents).set({ frozenAt: null });
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
  });

  it("refuses reused codes and revokes what they produced", async () => {
    const { clientId, code, verifier, exchanged } = await connect();
    const tokens = (await exchanged.json()) as Tokens;
    const again = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "invalid_grant" });
    expect(await mcpStatus(tokens.access_token)).toBe(401);
    expect(await db.select().from(securityAlerts)).toMatchObject([{ kind: "code_reused" }]);
  });

  it("checks PKCE, the client and expiry", async () => {
    const session = await signIn("owner@example.com");
    const { client } = await register();
    const clientId = String(client.client_id);
    const started = await authorize(clientId);
    const approved = await consent(
      "POST",
      started.requestId ?? "",
      [session, `callsign_oauth=${started.nonce}`],
      {
        decision: "approve",
        create: { handle: "pkce_agent", description: "Test agent.", product: "custom" },
      },
    );
    const { redirectTo } = (await approved.json()) as { redirectTo: string };
    const code = new URL(redirectTo).searchParams.get("code") ?? "";

    const wrongVerifier = await token({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      code_verifier: pkce().verifier,
    });
    expect(await wrongVerifier.json()).toMatchObject({ error: "invalid_grant" });

    const unknown = await token({
      grant_type: "refresh_token",
      refresh_token: "x",
      client_id: "nope",
    });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ error: "invalid_client" });

    const { exchanged } = await connect("other@example.com");
    const tokens = (await exchanged.json()) as Tokens;
    await sql`update agent_tokens set expires_at = now() - interval '1 second' where client_id is not null`;
    expect(await mcpStatus(tokens.access_token)).toBe(401);
  });

  it("rejects mismatched redirects and resources", async () => {
    const { client } = await register();
    const clientId = String(client.client_id);

    const mismatch = await authorize(clientId, { redirect_uri: "https://evil.example.com/cb" });
    expect(mismatch.response.status).toBe(400);
    expect(await mismatch.response.text()).toContain("redirect_uri");

    const otherPort = await authorize(clientId, { redirect_uri: "http://127.0.0.1:5555/callback" });
    expect(otherPort.location?.pathname).toBe("/oauth/consent");

    const wrongResource = await authorize(clientId, { resource: "https://other.example.com/mcp" });
    expect(wrongResource.location?.searchParams.get("error")).toBe("invalid_target");

    const noPkce = await authorize(clientId, { code_challenge_method: "plain" });
    expect(noPkce.location?.searchParams.get("error")).toBe("invalid_request");
  });

  it("only lets the browser that started the request answer it", async () => {
    const session = await signIn("owner@example.com");
    const { client } = await register();
    const started = await authorize(String(client.client_id));
    const requestId = started.requestId ?? "";

    const forwarded = await consent("GET", requestId, [session]);
    expect(forwarded.status).toBe(403);

    const view = await consent("GET", requestId, [session, `callsign_oauth=${started.nonce}`]);
    expect(await view.json()).toMatchObject({
      client: { name: "Claude Code", verifiedDomain: null, redirect: { local: true } },
      agents: [],
    });

    const denied = await consent("POST", requestId, [session, `callsign_oauth=${started.nonce}`], {
      decision: "deny",
    });
    const { redirectTo } = (await denied.json()) as { redirectTo: string };
    expect(new URL(redirectTo).searchParams.get("error")).toBe("access_denied");
  });

  it("accepts clients identified by a metadata document", async () => {
    const session = await signIn("owner@example.com");
    const started = await authorize(CIMD_CLIENT, {
      redirect_uri: "http://127.0.0.1:7777/callback",
    });
    const view = await consent("GET", started.requestId ?? "", [
      session,
      `callsign_oauth=${started.nonce}`,
    ]);
    expect(await view.json()).toMatchObject({
      client: { name: "Example Desktop", verifiedDomain: "client.example.com" },
    });
  });

  it("lets a client revoke its own tokens", async () => {
    const { clientId, exchanged } = await connect();
    const tokens = (await exchanged.json()) as Tokens;
    const revoked = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refresh_token, client_id: clientId }).toString(),
    });
    expect(revoked.status).toBe(200);
    expect(await mcpStatus(tokens.access_token)).toBe(401);
  });

  it("challenges unauthenticated MCP requests with the resource metadata", async () => {
    const status = await fetch(new URL("/mcp", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer csk_bogus" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(status.status).toBe(401);
    expect(status.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});
