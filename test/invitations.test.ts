import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { jobs } from "../src/db/schema.ts";
import { createAgent } from "../src/domain/agents.ts";
import { listContacts } from "../src/domain/contacts.ts";
import { connectInvitations, invitePerson } from "../src/domain/invitations.ts";
import { checkInbox, getConversation } from "../src/domain/messaging.ts";
import { createApp } from "../src/http/app.ts";
import { createAgentWithToken, createOwner } from "./helpers.ts";

const app = createApp();
const origin = "http://localhost:3001";

async function signUp(email: string) {
  await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email }),
  });
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "email.login"), sql`${jobs.payload}->>'email' = ${email}`));
  const token = new URL(String(job?.payload.url)).searchParams.get("token");
  await app.request("/v1/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token }),
  });
}

describe("inviting people", () => {
  it("connects a new user with the agent that invited them", async () => {
    const { agent: tomas } = await createAgentWithToken("tomas_agent");
    const sent = await invitePerson(tomas, {
      email: "Mateo@Partner.com",
      note: "Want to coordinate the launch here?",
    });
    expect(sent.sentTo).toBe("m***@partner.com");

    const [email] = await db.select().from(jobs).where(eq(jobs.kind, "email.invitation"));
    expect(email?.payload).toMatchObject({
      email: "mateo@partner.com",
      from: "@tomas_agent",
      existing: false,
    });
    const token = new URL(String(email?.payload.url)).searchParams.get("invite");
    const preview = await app.request(`/v1/invitations/${token}`);
    expect(await preview.json()).toMatchObject({
      from: { handle: "@tomas_agent" },
      note: "Want to coordinate the launch here?",
    });

    await signUp("mateo@partner.com");
    const [owner] = await db.query.owners.findMany({
      where: (o, { eq: is }) => is(o.email, "mateo@partner.com"),
    });
    if (!owner) throw new Error("no owner");
    expect((await listContacts(owner.id)).map((c) => c.agent.handle)).toEqual(["@tomas_agent"]);

    const mateo = await createAgent(owner, { handle: "mateo_agent", product: "grok-bot" });
    await connectInvitations(mateo);
    const inbox = await checkInbox(mateo);
    expect(inbox.threads[0]).toMatchObject({
      kind: "message",
      messages: [{ from: "@tomas_agent", body: "Want to coordinate the launch here?" }],
    });
    const conversation = await getConversation(tomas, "@mateo_agent", {
      limit: 5,
      markRead: false,
    });
    expect(conversation).toMatchObject({ myAcceptance: "accepted", theirAcceptance: "accepted" });
  });

  it("links existing users right away without revealing that they have an account", async () => {
    const { agent: tomas } = await createAgentWithToken("tomas_agent");
    const owner = await createOwner("ana@partner.com");
    const ana = await createAgent(owner, { handle: "ana_agent", product: "muse" });
    const sent = await invitePerson(tomas, { email: "ana@partner.com", note: "Hi Ana!" });
    expect(sent.sentTo).toBe("a***@partner.com");
    expect((await checkInbox(ana)).threads[0]?.messages[0]?.body).toBe("Hi Ana!");
  });

  it("refuses inviting your own owner", async () => {
    const { owner, agent } = await createAgentWithToken("tomas_agent");
    await expect(invitePerson(agent, { email: owner.email })).rejects.toThrow(/own email/);
  });
});
