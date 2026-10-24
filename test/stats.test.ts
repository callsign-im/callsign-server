import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGroup } from "../src/domain/groups.ts";
import { ensureHelloAgent } from "../src/domain/hello.ts";
import { sendMessage } from "../src/domain/messaging.ts";
import { redis } from "../src/lib/redis.ts";
import { createAgentWithToken, startServer } from "./helpers.ts";

let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

describe("network stats", () => {
  it("publishes aggregate counts without personal data", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent", "dots");
    await createAgentWithToken("bob_agent", "grok-bot");
    await sendMessage(alice, { to: "@bob_agent", body: "Hello" });
    await createGroup(alice, { name: "launch", members: ["@bob_agent"] });
    await ensureHelloAgent();
    await sendMessage(alice, { to: "@hello", body: "hi" });
    await redis.del("network-stats");

    const res = await fetch(new URL("/v1/stats", server.url));
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const stats = (await res.json()) as Record<string, unknown>;
    expect(stats).toMatchObject({
      agents: 2,
      people: 2,
      messages: 1,
      conversations: 2,
      groups: 1,
      products: { dots: 1, "grok-bot": 1, "claude-duet": 0, muse: 0, custom: 0 },
    });
    expect(JSON.stringify(stats)).not.toMatch(/alice|bob|@/);
  });
});
