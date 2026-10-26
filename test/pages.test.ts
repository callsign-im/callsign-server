import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { agents, owners } from "../src/db/schema.ts";
import { createAgent, updateAgent } from "../src/domain/agents.ts";
import { createSession } from "../src/domain/owners.ts";
import { createApp } from "../src/http/app.ts";
import { createOwner } from "./helpers.ts";

async function page(app: ReturnType<typeof createApp>, handle: string) {
  const res = await app.request(`/v1/pages/${handle}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("public agent pages", () => {
  it("only confirms the handle until the owner makes the page public", async () => {
    const app = createApp();
    const owner = await createOwner("mateo@acme.dev");
    const agent = await createAgent(owner, {
      handle: "mateorivasagent",
      product: "claude-duet",
      description: "Mateo's ops agent",
    });

    expect((await page(app, "nobodyhere")).status).toBe(404);
    expect(await page(app, "@mateorivasagent")).toEqual({
      status: 200,
      body: { handle: "@mateorivasagent", public: false },
    });

    await updateAgent(agent, { publicPage: true, publicEmail: true });
    const shown = await page(app, "mateorivasagent");
    expect(shown.body).toMatchObject({
      handle: "@mateorivasagent",
      public: true,
      displayName: agent.displayName,
      description: "Mateo's ops agent",
      product: "claude-duet",
      owner: { verifiedDomain: "acme.dev", since: owner.createdAt.toISOString() },
      // The email bridge is off in tests, so there is no address to show.
      email: null,
    });
    expect(JSON.stringify(shown.body)).not.toContain("mateo@acme.dev");
  });

  it("hides the owner's domain when they asked to and for personal email providers", async () => {
    const app = createApp();
    const company = await createOwner("tomas@acme.dev");
    const personal = await createOwner("bruno@gmail.com");
    await createAgent(company, { handle: "tomasagent", product: "dots" });
    await createAgent(personal, { handle: "brunoagent", product: "grok-bot" });
    await db.update(agents).set({ publicPage: true });
    await db.update(owners).set({ showDomain: false }).where(eq(owners.id, company.id));

    expect((await page(app, "tomasagent")).body).toMatchObject({ owner: { verifiedDomain: null } });
    expect((await page(app, "brunoagent")).body).toMatchObject({ owner: { verifiedDomain: null } });
  });

  it("lets the owner turn the page on, and drops suspended agents", async () => {
    const app = createApp();
    const owner = await createOwner();
    const agent = await createAgent(owner, { handle: "juliaagent", product: "muse" });
    const { sessionToken } = await createSession(db, owner.id);

    const patched = await app.request("/v1/agents/juliaagent", {
      method: "PATCH",
      headers: {
        cookie: `callsign_session=${sessionToken}`,
        origin: "http://localhost:3001",
        "content-type": "application/json",
      },
      body: JSON.stringify({ publicPage: true }),
    });
    expect(await patched.json()).toMatchObject({ agent: { publicPage: true } });
    expect((await page(app, "juliaagent")).body).toMatchObject({ public: true });

    await db.update(agents).set({ suspendedAt: new Date() }).where(eq(agents.id, agent.id));
    expect((await page(app, "juliaagent")).status).toBe(404);
  });
});
