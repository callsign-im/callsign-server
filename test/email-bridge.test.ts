import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.ts";
import { db } from "../src/db/client.ts";
import { agents } from "../src/db/schema.ts";
import { deleteAgent, pruneEmailContacts } from "../src/domain/account.ts";
import { findAgentByHandle, updateAgent } from "../src/domain/agents.ts";
import { replyText } from "../src/domain/email-inbound.ts";
import { createGroup } from "../src/domain/groups.ts";
import { checkInbox, sendMessage } from "../src/domain/messaging.ts";
import { createPlan } from "../src/domain/plans.ts";
import { createApp } from "../src/http/app.ts";
import { processDueJobs } from "../src/jobs/runner.ts";
import { standardSignature } from "../src/lib/crypto.ts";
import { sendMail, type Mail } from "../src/lib/mailer.ts";
import { createAgentWithToken } from "./helpers.ts";

vi.mock("../src/lib/mailer.ts", () => ({ sendMail: vi.fn(async () => {}) }));

const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const DOMAIN = "agents.callsign.test";
const inbox = new Map<string, Record<string, unknown>>();
const resend = createServer((req, res) => {
  const [, , , id, attachments] = (req.url ?? "").split("/");
  const email = inbox.get(id ?? "");
  res.writeHead(email ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify(attachments ? { data: [] } : (email ?? {})));
});
const app = createApp();

beforeAll(async () => {
  await new Promise<void>((resolve) => resend.listen(0, "127.0.0.1", resolve));
  Object.assign(config, {
    EMAIL_BRIDGE_DOMAIN: DOMAIN,
    RESEND_API_KEY: "re_test",
    RESEND_WEBHOOK_SECRET: SECRET,
    RESEND_API_URL: `http://127.0.0.1:${(resend.address() as AddressInfo).port}`,
  });
});

afterAll(() => {
  Object.assign(config, {
    EMAIL_BRIDGE_DOMAIN: undefined,
    RESEND_API_KEY: undefined,
    RESEND_WEBHOOK_SECRET: undefined,
  });
  resend.close();
});

beforeEach(() => {
  vi.mocked(sendMail).mockClear();
  inbox.clear();
});

async function drainJobs() {
  while ((await processDueJobs()) > 0);
}

function sentMails(): Mail[] {
  return vi.mocked(sendMail).mock.calls.map(([mail]) => mail);
}

let received = 0;
async function receive(email: Record<string, unknown>, signature?: string) {
  const id = `email_${++received}`;
  inbox.set(id, {
    subject: "Re: Message from alice_agent",
    html: null,
    headers: {},
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    ...email,
  });
  const body = JSON.stringify({ type: "email.received", data: { email_id: id } });
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await app.request("/v1/email/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": `msg_${id}`,
      "svix-timestamp": String(timestamp),
      "svix-signature": signature ?? standardSignature(SECRET, `msg_${id}`, timestamp, body),
    },
    body,
  });
  await drainJobs();
  return res;
}

async function emailAna() {
  const { agent: alice } = await createAgentWithToken("alice_agent");
  const sent = await sendMessage(alice, {
    to: "Ana@Northwind.test",
    body: "Hi Ana, can we move the call to Thursday?",
  });
  await drainJobs();
  const mail = sentMails().at(-1);
  return { alice, sent, replyTo: mail?.replyTo ?? "" };
}

describe("email bridge", () => {
  it("emails people who aren't on Callsign as the agent", async () => {
    const { sent, replyTo } = await emailAna();
    expect(sent).toMatchObject({ status: "request_sent", to: "ana@northwind.test" });
    const [mail] = sentMails();
    expect(sentMails()).toHaveLength(1);
    expect(mail).toMatchObject({
      to: "ana@northwind.test",
      fromName: "alice_agent via Callsign",
      subject: "Message from alice_agent (@alice_agent)",
    });
    expect(mail?.text).toContain("Hi Ana, can we move the call to Thursday?");
    expect(replyTo).toMatch(new RegExp(`^alice_agent\\+[0-9a-f]{16}@${DOMAIN}$`));
  });

  it("points to the person's agent when they have one", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { owner } = await createAgentWithToken("bob_agent");
    await expect(sendMessage(alice, { to: owner.email, body: "Hi" })).rejects.toThrow(
      /has an agent on Callsign: @bob_agent/,
    );
  });

  it("delivers replies to the agent's inbox without the quoted thread", async () => {
    const { alice, replyTo } = await emailAna();
    const res = await receive({
      from: "Ana Pérez <ana@northwind.test>",
      to: [replyTo],
      text: "Thursday works.\n\nOn Mon, Oct 26, 2026 at 10:00 alice_agent <x@y.z> wrote:\n> Hi Ana",
    });
    expect(res.status).toBe(200);

    const thread = (await checkInbox(alice)).threads[0];
    expect(thread?.with).toMatchObject({ handle: "ana@northwind.test", displayName: "Ana Pérez" });
    expect(thread?.messages.map((m) => [m.from, m.body])).toEqual([
      ["ana@northwind.test", "Thursday works."],
    ]);

    await sendMessage(alice, { to: "ana@northwind.test", body: "Great, booked." });
    await drainJobs();
    expect(sentMails().at(-1)?.subject).toBe("Re: Message from alice_agent (@alice_agent)");
  });

  it("rejects unsigned, spoofed and unsolicited email", async () => {
    const { alice, replyTo } = await emailAna();
    expect(
      (await receive({ from: "ana@northwind.test", to: [replyTo], text: "x" }, "v1,bad")).status,
    ).toBe(404);
    await receive({
      from: "ana@northwind.test",
      to: [replyTo],
      text: "Spoofed",
      authentication: { spf: "fail", dkim: "fail", dmarc: "fail" },
    });
    await receive({ from: "stranger@else.test", to: [`alice_agent@${DOMAIN}`], text: "Hello?" });
    await receive({ from: "eve@else.test", to: [replyTo], text: "Forwarded thread" });
    expect((await checkInbox(alice)).threads).toEqual([]);
  });

  it("lets owners open the address to anyone, as message requests", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    await updateAgent(alice, { publicEmail: true });
    await receive({
      from: "Carla <carla@shop.test>",
      to: [`alice_agent@${DOMAIN}`],
      subject: "Wholesale prices",
      text: "Do you sell wholesale?",
    });
    const thread = (await checkInbox(alice)).threads[0];
    expect(thread?.kind).toBe("request");
    expect(thread?.messages[0]?.body).toBe("Subject: Wholesale prices\n\nDo you sell wholesale?");
  });

  it("stops emailing someone who replies stop", async () => {
    const { alice, replyTo } = await emailAna();
    await receive({ from: "ana@northwind.test", to: [replyTo], text: "STOP" });
    await expect(sendMessage(alice, { to: "ana@northwind.test", body: "Hello?" })).rejects.toThrow(
      /not accepting messages/,
    );
  });

  it("keeps email addresses out of groups and plans", async () => {
    const { alice } = await emailAna();
    await expect(
      createGroup(alice, { name: "launch", members: ["ana@northwind.test"] }),
    ).rejects.toThrow(/groups are for agents/);
    await expect(
      createPlan(alice, { with: "ana@northwind.test", title: "Call", tasks: [{ title: "Book" }] }),
    ).rejects.toThrow(/not email addresses/);
  });

  it("forgets an address once no conversation uses it", async () => {
    const { alice } = await emailAna();
    await deleteAgent(alice);
    await db
      .update(agents)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(agents.handle, "ana@northwind.test"));
    await pruneEmailContacts();
    expect(await findAgentByHandle("ana@northwind.test")).toBeUndefined();
  });

  it("keeps only what the person wrote", () => {
    expect(
      replyText("Sí, el jueves.\n\nEl lun, 26 oct 2026 a las 10:00, Alice escribió:\n> Hola"),
    ).toBe("Sí, el jueves.");
    expect(replyText("Done.\n-- \nAna Pérez\nNorthwind")).toBe("Done.");
    expect(replyText("Ok\r\n\r\nFrom: Alice\r\nSent: Monday\r\nHi")).toBe("Ok");
  });
});
