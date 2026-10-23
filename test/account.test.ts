import { describe, expect, it } from "vitest";
import { db, sql } from "../src/db/client.ts";
import { deleteAccount, deleteAgent, exportAccount } from "../src/domain/account.ts";
import { createAgent, findAgentByHandle, updateAgent } from "../src/domain/agents.ts";
import { listContacts, saveContact } from "../src/domain/contacts.ts";
import { verifyLedger } from "../src/domain/ledger.ts";
import { listConversations, sendMessage } from "../src/domain/messaging.ts";
import { createSession, requestLogin } from "../src/domain/owners.ts";
import { createApp } from "../src/http/app.ts";
import { createAgentWithToken } from "./helpers.ts";

describe("deleting agents and accounts", () => {
  it("deletes an agent's data and promotes another primary", async () => {
    const { agent: mateo, owner } = await createAgentWithToken("mateorivasagent");
    await createAgent(owner, { handle: "mateo_backup", product: "custom" });
    const { agent: tomas } = await createAgentWithToken("tomasagent");
    await sendMessage(tomas, { to: "@mateorivasagent", body: "Invoice attached" });
    await saveContact(tomas.ownerId, { handle: "@mateorivasagent", name: "Mateo" });

    await deleteAgent(mateo);

    expect(await findAgentByHandle("mateorivasagent")).toBeUndefined();
    expect(await listConversations(tomas)).toEqual([]);
    expect(await listContacts(tomas.ownerId)).toEqual([]);
    const [ledger] = await sql<{ total: number }[]>`
      select count(*)::int as total from ledger_events where agent_id = ${mateo.id}`;
    expect(ledger?.total).toBe(0);
    expect(await verifyLedger(tomas)).toMatchObject({ valid: true });
    expect((await findAgentByHandle("mateo_backup"))?.primary).toBe(true);
  });

  it("holds a deleted agent's handle for 30 days", async () => {
    const app = createApp();
    const { agent: mateo, owner } = await createAgentWithToken("mateorivasagent");
    await deleteAgent(mateo);

    const check = await app.request("/v1/handles/mateorivasagent");
    const { status, availableAt } = (await check.json()) as { status: string; availableAt: string };
    expect(status).toBe("held");
    expect(new Date(availableAt).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);

    await expect(
      createAgent(owner, { handle: "mateorivasagent", product: "dots" }),
    ).rejects.toThrow(/can be claimed again on \d{4}-\d{2}-\d{2}/);
    const registration = await app.request("/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "mateorivasagent", ownerEmail: "someone@example.com" }),
    });
    expect(registration.status).toBe(409);

    await sql`update held_handles set available_at = now() - interval '1 minute'`;
    const { agent: newcomer } = await createAgentWithToken("mateorivasagent");
    expect(newcomer.id).not.toBe(mateo.id);
  });

  it("still rejects ledger deletes outside of an agent's erasure", async () => {
    const { agent } = await createAgentWithToken("mateorivasagent");
    await expect(sql`delete from ledger_events where agent_id = ${agent.id}`).rejects.toThrow(
      /append-only/,
    );
  });

  it("deletes an account and everything it owns", async () => {
    const { agent: mateo, owner } = await createAgentWithToken("mateorivasagent");
    const { agent: tomas } = await createAgentWithToken("tomasagent");
    await sendMessage(mateo, { to: "@tomasagent", body: "Hi" });
    await saveContact(owner.id, { handle: "@tomasagent", name: "Tomás" });
    await createSession(db, owner.id);
    await requestLogin(owner.email, "127.0.0.1");

    await deleteAccount(owner);

    const [remaining] = await sql`
      select
        (select count(*) from owners where id = ${owner.id})::int as owners,
        (select count(*) from agents where owner_id = ${owner.id})::int as agents,
        (select count(*) from contacts where owner_id = ${owner.id})::int as contacts,
        (select count(*) from sessions where owner_id = ${owner.id})::int as sessions,
        (select count(*) from login_tokens where email = ${owner.email})::int as logins,
        (select count(*) from jobs where payload->>'email' = ${owner.email})::int as jobs`;
    expect(remaining).toEqual({
      owners: 0,
      agents: 0,
      contacts: 0,
      sessions: 0,
      logins: 0,
      jobs: 0,
    });
    expect(await listConversations(tomas)).toEqual([]);
  });

  it("exports an owner's data with decrypted content and no secrets", async () => {
    const { agent: mateo, owner } = await createAgentWithToken("mateorivasagent");
    await createAgentWithToken("tomasagent");
    await updateAgent(mateo, { rules: "Be brief." });
    await sendMessage(mateo, { to: "@tomasagent", body: "Contract signed" });
    await saveContact(owner.id, { handle: "@tomasagent", name: "Tomás" });

    const exported = await exportAccount(owner);
    expect(exported).toMatchObject({
      owner: { email: owner.email },
      contacts: [{ name: "Tomás" }],
      agents: [
        {
          handle: "@mateorivasagent",
          primary: true,
          rules: "Be brief.",
          conversations: [{ with: "@tomasagent", messages: [{ body: "Contract signed" }] }],
        },
      ],
    });
    expect(exported.agents[0]?.ledger.map((event) => event.type)).toContain("request.sent");
    expect(JSON.stringify(exported)).not.toContain("whsec_");
  });

  it("serves deletion and export to signed-in owners", async () => {
    const app = createApp();
    const { owner } = await createAgentWithToken("mateorivasagent");
    const { sessionToken } = await createSession(db, owner.id);
    const headers = {
      cookie: `callsign_session=${sessionToken}`,
      origin: "http://localhost:3001",
    };

    const exported = await app.request("/v1/me/export", { headers });
    expect(exported.headers.get("content-disposition")).toMatch(
      /^attachment; filename="callsign-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );

    const removed = await app.request("/v1/agents/mateorivasagent", { method: "DELETE", headers });
    expect(removed.status).toBe(204);

    const closed = await app.request("/v1/me", { method: "DELETE", headers });
    expect(closed.status).toBe(204);
    expect(closed.headers.get("set-cookie")).toMatch(/^callsign_session=;/);
    expect((await app.request("/v1/me", { headers })).status).toBe(401);
  });
});
