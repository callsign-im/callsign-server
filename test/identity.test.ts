import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { jobs, owners } from "../src/db/schema.ts";
import { createAgent, createAgentToken } from "../src/domain/agents.ts";
import { saveContact } from "../src/domain/contacts.ts";
import { ownerSignals } from "../src/domain/identity.ts";
import { checkInbox, sendMessage } from "../src/domain/messaging.ts";
import { createApp } from "../src/http/app.ts";
import { createOwner } from "./helpers.ts";

const app = createApp();
const origin = "http://localhost:3001";

async function signIn(email: string): Promise<{ cookie: string; created: boolean }> {
  await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email }),
  });
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "email.login"), sql`${jobs.payload}->>'email' = ${email}`))
    .orderBy(sql`${jobs.createdAt} desc`)
    .limit(1);
  const token = new URL(String(job?.payload.url)).searchParams.get("token");
  const response = await app.request("/v1/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token }),
  });
  const { created } = (await response.json()) as { created: boolean };
  return { cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", created };
}

async function setup() {
  const tomas = await createOwner("tomas@majily.com");
  const mateo = await createOwner("mateo@majily.com");
  const stranger = await createOwner("someone@gmail.com");
  const tomasAgent = await createAgent(tomas, { handle: "tomas_agent", product: "dots" });
  const mateoAgent = await createAgent(mateo, { handle: "mateo_agent", product: "grok-bot" });
  await createAgent(mateo, { handle: "mateo_home", product: "muse" });
  const strangerAgent = await createAgent(stranger, { handle: "stranger", product: "custom" });
  const shared = await createAgent(await createOwner(), {
    handle: "accountant",
    product: "custom",
  });
  return { tomas, mateo, tomasAgent, mateoAgent, strangerAgent, shared };
}

describe("owner signals", () => {
  it("shows verified corporate domains, organizations, age and mutual contacts", async () => {
    const { tomas, mateo, tomasAgent, mateoAgent, strangerAgent, shared } = await setup();
    await saveContact(tomas.id, { handle: shared.handle, name: "Accountant" });
    await saveContact(mateo.id, { handle: shared.handle, name: "Our accountant" });

    const signals = await ownerSignals(tomasAgent, [mateoAgent, strangerAgent]);
    expect(signals.get(mateoAgent.id)).toMatchObject({
      verifiedDomain: "majily.com",
      sameOrganization: true,
      agents: 2,
      mutualContacts: 1,
    });
    expect(signals.get(strangerAgent.id)).toMatchObject({
      verifiedDomain: null,
      sameOrganization: false,
      agents: 1,
      mutualContacts: 0,
    });
  });

  it("lets owners hide their domain but still recognizes colleagues", async () => {
    const { mateo, tomasAgent, mateoAgent } = await setup();
    await db.update(owners).set({ showDomain: false }).where(eq(owners.id, mateo.id));
    const signals = await ownerSignals(tomasAgent, [mateoAgent]);
    expect(signals.get(mateoAgent.id)).toMatchObject({
      verifiedDomain: null,
      sameOrganization: true,
    });
  });

  it("travels with inbox threads, lookups and the MCP text", async () => {
    const { tomasAgent, mateoAgent } = await setup();
    await sendMessage(mateoAgent, { to: "@tomas_agent", body: "Can you share the budget?" });
    const inbox = await checkInbox(tomasAgent);
    expect(inbox.threads[0]?.with.owner).toMatchObject({
      verifiedDomain: "majily.com",
      sameOrganization: true,
    });

    const { token } = await createAgentToken(tomasAgent, "test");
    const lookup = await app.request("/v1/agent/lookup/mateo_agent", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await lookup.json()).toMatchObject({
      handle: "@mateo_agent",
      owner: { verifiedDomain: "majily.com", sameOrganization: true, agents: 2 },
    });
  });

  it("lets owners hide the domain from their account", async () => {
    const first = await signIn("tomas@majily.com");
    expect(first.created).toBe(true);
    const again = await signIn("tomas@majily.com");
    expect(again.created).toBe(false);

    const hidden = await app.request("/v1/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin, cookie: again.cookie },
      body: JSON.stringify({ showDomain: false }),
    });
    expect(await hidden.json()).toMatchObject({
      owner: { showDomain: false, organizationDomain: "majily.com" },
    });
  });
});
