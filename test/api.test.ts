import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { jobs } from "../src/db/schema.ts";
import { createApp } from "../src/http/app.ts";

const app = createApp();
const origin = "http://localhost:3001";

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
  });
}

async function signIn(email: string): Promise<string> {
  expect((await post("/v1/auth/login", { email })).status).toBe(202);
  const [job] = await db.select().from(jobs).where(eq(jobs.kind, "email.login"));
  const url = new URL(String(job?.payload.url));
  const response = await post("/v1/auth/verify", { token: url.searchParams.get("token") });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

describe("http api", () => {
  it("signs owners in with a single-use magic link", async () => {
    const cookie = await signIn("Owner@Example.com");
    const me = await app.request("/v1/me", { headers: { cookie } });
    expect(await me.json()).toMatchObject({ owner: { email: "owner@example.com" } });

    const [job] = await db.select().from(jobs).where(eq(jobs.kind, "email.login"));
    const token = new URL(String(job?.payload.url)).searchParams.get("token");
    const reuse = await post("/v1/auth/verify", { token });
    expect(reuse.status).toBe(401);
  });

  it("lets owners register agents, mint tokens and message as the agent", async () => {
    const cookie = await signIn("owner@example.com");

    const created = await post(
      "/v1/agents",
      { handle: "@Tomas_Agent", product: "dots" },
      { cookie },
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ agent: { handle: "@tomas_agent" } });
    expect(
      (await post("/v1/agents", { handle: "mateo_agent", product: "muse" }, { cookie })).status,
    ).toBe(201);

    const taken = await post("/v1/agents", { handle: "tomas_agent", product: "dots" }, { cookie });
    expect(taken.status).toBe(409);

    const minted = await post("/v1/agents/tomas_agent/tokens", { name: "ChatGPT" }, { cookie });
    const { token } = (await minted.json()) as { token: string };
    expect(token).toMatch(/^csk_/);

    const sent = await post(
      "/v1/agent/messages",
      { to: "@mateo_agent", body: "Hola" },
      { authorization: `Bearer ${token}` },
    );
    expect(sent.status).toBe(201);
    expect(await sent.json()).toMatchObject({ status: "delivered", to: "@mateo_agent" });

    const activity = await app.request("/v1/activity", { headers: { cookie } });
    const { events } = (await activity.json()) as { events: { type: string }[] };
    expect(events.map((e) => e.type)).toContain("message.received");

    const verify = await app.request("/v1/agents/tomas_agent/ledger/verify", {
      headers: { cookie },
    });
    expect(await verify.json()).toMatchObject({ valid: true });
  });

  it("reports handle availability publicly", async () => {
    const response = await app.request("/v1/handles/@Support");
    expect(await response.json()).toMatchObject({ handle: "@support", status: "reserved" });
  });

  it("requires authentication and rejects cross-origin writes", async () => {
    expect((await app.request("/v1/agents")).status).toBe(401);
    expect((await app.request("/v1/agent/inbox")).status).toBe(401);

    const cookie = await signIn("owner@example.com");
    const forged = await post(
      "/v1/agents",
      { handle: "evil_agent", product: "custom" },
      { cookie, origin: "https://evil.example" },
    );
    expect(forged.status).toBe(403);
  });

  it("returns structured validation errors", async () => {
    const response = await post("/v1/auth/login", { email: "not-an-email" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_input" } });
  });
});
