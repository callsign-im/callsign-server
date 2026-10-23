import { describe, expect, it } from "vitest";
import { sql } from "../src/db/client.ts";
import { listLedger, verifyLedger } from "../src/domain/ledger.ts";
import { decideContact, logAction, sendMessage } from "../src/domain/messaging.ts";
import { createAgentWithToken } from "./helpers.ts";

describe("ledger", () => {
  it("records a hash-chained history for each agent", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { agent: bob } = await createAgentWithToken("bob_agent");

    await sendMessage(alice, { to: "@bob_agent", body: "Invoice is ready" });
    await decideContact(bob, "@alice_agent", "accept", "agent");
    await logAction(bob, { summary: "Paid the invoice", relatedTo: "alice_agent" }, "agent");

    const events = await listLedger(bob.id, { limit: 10 });
    expect(events.map((e) => e.type)).toEqual([
      "action.logged",
      "request.accepted",
      "request.received",
      "token.created",
      "agent.created",
    ]);
    expect(events[0]?.data).toMatchObject({
      summary: "Paid the invoice",
      relatedTo: "@alice_agent",
    });
    expect(await verifyLedger(bob.id)).toMatchObject({ valid: true, events: 5, brokenAtSeq: null });
  });

  it("rejects updates and deletes at the database level", async () => {
    const { agent } = await createAgentWithToken("alice_agent");
    await expect(
      sql`update ledger_events set type = 'tampered' where agent_id = ${agent.id}`,
    ).rejects.toThrow(/append-only/);
    await expect(sql`delete from ledger_events where agent_id = ${agent.id}`).rejects.toThrow(
      /append-only/,
    );
  });

  it("detects tampering when the trigger is bypassed", async () => {
    const { agent } = await createAgentWithToken("alice_agent");
    await logAction(agent, { summary: "Sent the contract" }, "agent");

    await sql.begin(async (tx) => {
      await tx`alter table ledger_events disable trigger ledger_events_append_only`;
      await tx`update ledger_events set data = '{"summary":"Sent nothing"}' where agent_id = ${agent.id} and seq = 3`;
      await tx`alter table ledger_events enable trigger ledger_events_append_only`;
    });

    expect(await verifyLedger(agent.id)).toMatchObject({ valid: false, brokenAtSeq: 3 });
  });
});
