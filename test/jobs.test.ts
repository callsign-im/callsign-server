import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { jobs } from "../src/db/schema.ts";
import { updateAgent } from "../src/domain/agents.ts";
import { sendMessage } from "../src/domain/messaging.ts";
import { requestLogin } from "../src/domain/owners.ts";
import { uuidv7 } from "../src/lib/ids.ts";
import { signWebhook } from "../src/jobs/handlers.ts";
import { processDueJobs } from "../src/jobs/runner.ts";
import { createAgentWithToken } from "./helpers.ts";

type Received = { headers: IncomingHttpHeaders; body: string };

const servers: { close: () => void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function webhookReceiver(status: number) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/hooks/callsign`, received };
}

describe("background jobs", () => {
  it("delivers signed webhooks to the recipient", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { agent: bob } = await createAgentWithToken("bob_agent");
    const receiver = await webhookReceiver(200);
    const configured = await updateAgent(bob, { webhookUrl: receiver.url });

    await sendMessage(alice, { to: "@bob_agent", body: "Wake up, Bob" });
    expect(await processDueJobs()).toBe(1);

    expect(receiver.received).toHaveLength(1);
    const [delivery] = receiver.received;
    const event = JSON.parse(delivery?.body ?? "{}") as Record<string, unknown>;
    expect(event).toMatchObject({
      type: "request.received",
      agent: "@bob_agent",
      from: "@alice_agent",
    });
    expect(delivery?.body).not.toContain("Wake up");

    const signature = String(delivery?.headers["x-callsign-signature"]);
    const timestamp = Number(/t=(\d+)/.exec(signature)?.[1]);
    expect(signature).toBe(signWebhook(configured.webhookSecret, timestamp, delivery?.body ?? ""));
  });

  it("retries failed webhooks with backoff", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { agent: bob } = await createAgentWithToken("bob_agent");
    const receiver = await webhookReceiver(500);
    await updateAgent(bob, { webhookUrl: receiver.url });

    await sendMessage(alice, { to: "@bob_agent", body: "Hello" });
    await processDueJobs();

    const [job] = await db.select().from(jobs).where(eq(jobs.kind, "agent.webhook"));
    expect(job).toMatchObject({ attempts: 1, completedAt: null, failedAt: null });
    expect(job?.lastError).toContain("500");
    expect(job?.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("emails magic links over SMTP", async () => {
    const email = `login-${uuidv7()}@example.com`;
    await requestLogin(email, "127.0.0.1");
    expect(await processDueJobs()).toBe(1);

    const search = new URL("/api/v1/search", process.env.MAILPIT_URL);
    search.searchParams.set("query", `to:${email}`);
    const result = (await (await fetch(search)).json()) as { messages_count: number };
    expect(result.messages_count).toBe(1);
  });
});
