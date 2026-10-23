import { describe, expect, it } from "vitest";
import { updateAgent } from "../src/domain/agents.ts";
import { findAgents, listContacts, saveContact } from "../src/domain/contacts.ts";
import { listLedger } from "../src/domain/ledger.ts";
import { checkInbox, getConversation, sendMessage } from "../src/domain/messaging.ts";
import { db } from "../src/db/client.ts";
import { createSession } from "../src/domain/owners.ts";
import { createApp } from "../src/http/app.ts";
import { createAgentWithToken, createOwner } from "./helpers.ts";

describe("contacts and discovery", () => {
  it("finds agents by handle, owner email and contact name", async () => {
    const { agent: tomas } = await createAgentWithToken("tomasagent");
    const mateo = await createAgentWithToken("mateorivasagent", "claude-duet");
    await saveContact(tomas.ownerId, { handle: "@mateorivasagent", name: "Mateo (co-founder)" });

    const byHandle = await findAgents(tomas, "@mateorivasagent");
    expect(byHandle).toMatchObject([
      { handle: "@mateorivasagent", matchedBy: "handle", contact: "Mateo (co-founder)" },
    ]);

    const byEmail = await findAgents(tomas, mateo.owner.email.toUpperCase());
    expect(byEmail).toMatchObject([{ handle: "@mateorivasagent", matchedBy: "email" }]);

    const byName = await findAgents(tomas, "mateo");
    expect(byName).toMatchObject([{ handle: "@mateorivasagent", matchedBy: "contact" }]);

    await updateAgent(mateo.agent, { discoverable: false });
    expect(await findAgents(tomas, mateo.owner.email)).toEqual([]);
  });

  it("records contacts saved by agents on their ledger", async () => {
    const { agent: tomas } = await createAgentWithToken("tomasagent");
    await createAgentWithToken("mateorivasagent");

    await saveContact(tomas.ownerId, { handle: "mateorivasagent", name: "Mateo" }, tomas);
    const [latest] = await listLedger(tomas, { limit: 1 });
    expect(latest).toMatchObject({ type: "contact.saved", data: { name: "Mateo" } });
    expect(await listContacts(tomas.ownerId)).toMatchObject([
      { name: "Mateo", agent: { handle: "@mateorivasagent" } },
    ]);
  });

  it("gives agents their owner's rules and the sender's contact name", async () => {
    const { agent: tomas } = await createAgentWithToken("tomasagent");
    const created = await createAgentWithToken("mateorivasagent");
    const mateo = await updateAgent(created.agent, {
      rules: "Never commit to spending over $500.",
    });
    await saveContact(mateo.ownerId, {
      handle: "tomasagent",
      name: "Tomás (co-founder)",
      rules: "Share invoices and calendars freely.",
    });

    await sendMessage(tomas, { to: "@mateorivasagent", body: "Can you review the AWS bill?" });
    const inbox = await checkInbox(mateo);
    expect(inbox.rules).toBe("Never commit to spending over $500.");
    expect(inbox.threads[0]?.contact).toEqual({
      name: "Tomás (co-founder)",
      notes: null,
      rules: "Share invoices and calendars freely.",
    });

    const conversation = await getConversation(mateo, "@tomasagent", {
      limit: 10,
      markRead: false,
    });
    expect(conversation.contact?.name).toBe("Tomás (co-founder)");
  });

  it("lets owners manage contacts over HTTP", async () => {
    const app = createApp();
    const owner = await createOwner();
    await createAgentWithToken("mateorivasagent");
    const { sessionToken } = await createSession(db, owner.id);
    const headers = {
      cookie: `callsign_session=${sessionToken}`,
      "content-type": "application/json",
      origin: "http://localhost:3000",
    };

    const created = await app.request("/v1/contacts", {
      method: "POST",
      headers,
      body: JSON.stringify({ handle: "@mateorivasagent", name: "Mateo", rules: "Be brief." }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const renamed = await app.request(`/v1/contacts/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Mateo Rivas" }),
    });
    expect(await renamed.json()).toMatchObject({ name: "Mateo Rivas", rules: "Be brief." });

    const removed = await app.request(`/v1/contacts/${id}`, { method: "DELETE", headers });
    expect(removed.status).toBe(204);
    expect(await listContacts(owner.id)).toEqual([]);
  });

  it("gives owners instructions to paste into their agent", async () => {
    const app = createApp();
    const { owner } = await createAgentWithToken("tomasagent");
    const { sessionToken } = await createSession(db, owner.id);
    const response = await app.request("/v1/agents/tomasagent/instructions", {
      headers: { cookie: `callsign_session=${sessionToken}` },
    });
    const body = (await response.json()) as { instructions: string; memoryNote: string };
    expect(body.instructions).toContain("You are @tomasagent on Callsign");
    expect(body.memoryNote).toContain("@tomasagent");
  });
});
