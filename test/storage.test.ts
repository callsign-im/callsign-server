import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "../src/db/client.ts";
import { updateAgent } from "../src/domain/agents.ts";
import { listContacts, saveContact } from "../src/domain/contacts.ts";
import { listLedger, verifyLedger } from "../src/domain/ledger.ts";
import { getConversation, logAction, sendMessage } from "../src/domain/messaging.ts";
import { createAgentWithToken } from "./helpers.ts";

async function pair() {
  const { agent: alice } = await createAgentWithToken("alice_agent");
  const { agent: bob } = await createAgentWithToken("bob_agent");
  return { alice, bob };
}

describe("encryption at rest", () => {
  it("stores message bodies encrypted and returns them to the participants", async () => {
    const { alice, bob } = await pair();
    await sendMessage(alice, { to: "@bob_agent", body: "The bank PIN is 4512" });

    const [stored] = await sql<{ body: string }[]>`select body from messages`;
    expect(stored?.body).toMatch(/^v1\./);
    expect(stored?.body).not.toContain("4512");

    const conversation = await getConversation(bob, "@alice_agent", { limit: 10, markRead: true });
    expect(conversation.messages.map((m) => m.body)).toEqual(["The bank PIN is 4512"]);

    const keys = await sql<{ owner: string; conversation: string }[]>`
      select o.data_key as owner, c.data_key as conversation
      from owners o, conversations c limit 1`;
    expect(keys[0]?.owner).toMatch(/^local\./);
    expect(keys[0]?.conversation).toMatch(/^local\./);
  });

  it("refuses to decrypt a message moved to another row", async () => {
    const { alice, bob } = await pair();
    await sendMessage(alice, { to: "@bob_agent", body: "Pay the invoice" });
    await sendMessage(alice, { to: "@bob_agent", body: "Don't pay the invoice" });

    await sql`update messages set body = (select body from messages where seq = 1) where seq = 2`;

    await expect(
      getConversation(bob, "@alice_agent", { limit: 10, markRead: false }),
    ).rejects.toThrow();
  });

  it("stores ledger entries encrypted with keyed content hashes", async () => {
    const { alice } = await pair();
    await sendMessage(alice, { to: "@bob_agent", body: "ok" });
    await logAction(alice, { summary: "Wired $12,000 to the supplier" }, "agent");

    const stored = await sql<{ data: string }[]>`
      select data from ledger_events where agent_id = ${alice.id}`;
    expect(stored.every((row) => row.data.startsWith("v1."))).toBe(true);
    expect(stored.some((row) => row.data.includes("Wired"))).toBe(false);

    const [logged, sent] = await listLedger(alice, { limit: 2 });
    expect(logged?.data).toMatchObject({ summary: "Wired $12,000 to the supplier" });
    expect(sent?.data.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sent?.data.contentHash).not.toBe(createHash("sha256").update("ok").digest("hex"));
    expect(await verifyLedger(alice)).toMatchObject({ valid: true });
  });

  it("detects ledger entries swapped at the database level", async () => {
    const { alice } = await pair();
    await logAction(alice, { summary: "Signed the lease" }, "agent");
    await logAction(alice, { summary: "Cancelled the lease" }, "agent");

    await sql.begin(async (tx) => {
      await tx`alter table ledger_events disable trigger ledger_events_append_only`;
      await tx`update ledger_events set data = (
        select data from ledger_events where agent_id = ${alice.id} and seq = 3
      ) where agent_id = ${alice.id} and seq = 4`;
      await tx`alter table ledger_events enable trigger ledger_events_append_only`;
    });

    expect(await verifyLedger(alice)).toMatchObject({ valid: false, brokenAtSeq: 4 });
  });

  it("stores owner rules, contacts and webhook secrets encrypted", async () => {
    const { alice, bob } = await pair();
    await updateAgent(alice, { rules: "Never share bank details." });
    await saveContact(alice.ownerId, {
      handle: "@bob_agent",
      name: "Bob (accountant)",
      notes: "Handles payroll.",
      rules: "Share invoices freely.",
    });

    const [agent] = await sql<{ rules: string; webhook_secret: string }[]>`
      select rules, webhook_secret from agents where id = ${alice.id}`;
    expect(agent?.rules).toMatch(/^v1\./);
    expect(agent?.webhook_secret).toMatch(/^v1\./);
    expect(agent?.webhook_secret).not.toContain("whsec");

    const [contact] = await sql<{ name: string; notes: string; rules: string }[]>`
      select name, notes, rules from contacts where agent_id = ${bob.id}`;
    expect(Object.values(contact ?? {}).every((value) => value.startsWith("v1."))).toBe(true);

    expect(await listContacts(alice.ownerId)).toMatchObject([
      { name: "Bob (accountant)", notes: "Handles payroll.", rules: "Share invoices freely." },
    ]);
  });
});
