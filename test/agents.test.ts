import { describe, expect, it } from "vitest";
import { createAgent, listOwnerAgents, updateAgent } from "../src/domain/agents.ts";
import { findAgents } from "../src/domain/contacts.ts";
import { listLedger } from "../src/domain/ledger.ts";
import { checkInbox, sendMessage } from "../src/domain/messaging.ts";
import { createAgentWithToken, createOwner } from "./helpers.ts";

describe("primary agents and descriptions", () => {
  it("makes the first agent primary and lets the owner switch it", async () => {
    const owner = await createOwner();
    const work = await createAgent(owner, {
      handle: "mateo_work",
      product: "dots",
      description: "  Handles\n invoices  and payroll. ",
    });
    const home = await createAgent(owner, { handle: "mateo_home", product: "muse" });
    expect([work.primary, home.primary]).toEqual([true, false]);
    expect(work.description).toBe("Handles invoices and payroll.");

    await updateAgent(home, { primary: true });
    const agents = await listOwnerAgents(owner.id);
    expect(agents.map((a) => [a.handle, a.primary])).toEqual([
      ["mateo_work", false],
      ["mateo_home", true],
    ]);
  });

  it("returns the primary agent first when someone looks the owner up by email", async () => {
    const owner = await createOwner();
    await createAgent(owner, { handle: "mateo_work", product: "dots" });
    const home = await createAgent(owner, {
      handle: "mateo_home",
      product: "muse",
      description: "Family calendar",
    });
    await updateAgent(home, { primary: true });
    const { agent: tomas } = await createAgentWithToken("tomasagent");

    expect(await findAgents(tomas, owner.email)).toMatchObject([
      { handle: "@mateo_home", primary: true, description: "Family calendar" },
      { handle: "@mateo_work", primary: false },
    ]);
  });
});

describe("agents of the same owner", () => {
  it("message each other without a request", async () => {
    const owner = await createOwner();
    const dots = await createAgent(owner, { handle: "agus_dots", product: "dots" });
    const claude = await createAgent(owner, { handle: "agus_claude", product: "claude-duet" });

    const sent = await sendMessage(dots, { to: "@agus_claude", body: "Taking over the invoices" });
    expect(sent.status).toBe("delivered");

    const inbox = await checkInbox(claude);
    expect(inbox.threads).toMatchObject([{ kind: "message", sameOwner: true }]);
    const [received] = await listLedger(claude, { limit: 1 });
    expect(received?.type).toBe("message.received");
  });
});
