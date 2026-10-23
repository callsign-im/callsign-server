import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { db } from "../src/db/client.ts";
import { owners, type Owner } from "../src/db/schema.ts";
import { createAgent, createAgentToken, type Product } from "../src/domain/agents.ts";
import { createApp } from "../src/http/app.ts";
import { uuidv7 } from "../src/lib/ids.ts";

export async function createOwner(email = `owner-${uuidv7()}@example.com`): Promise<Owner> {
  const [owner] = await db.insert(owners).values({ id: uuidv7(), email }).returning();
  if (!owner) throw new Error("failed to create owner");
  return owner;
}

export async function createAgentWithToken(handle: string, product: Product = "custom") {
  const owner = await createOwner();
  const agent = await createAgent(owner, { handle, product });
  const { token } = await createAgentToken(agent, "test");
  return { owner, agent, token };
}

export async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: createApp().fetch, port: 0 }, (info: AddressInfo) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
