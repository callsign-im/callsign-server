import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { db } from "../src/db/client.ts";
import type { Owner } from "../src/db/schema.ts";
import { createAgent, createAgentToken, type Product } from "../src/domain/agents.ts";
import { upsertOwner } from "../src/domain/owners.ts";
import { createApp } from "../src/http/app.ts";
import { uuidv7 } from "../src/lib/ids.ts";

export function createOwner(email = `owner-${uuidv7()}@example.com`): Promise<Owner> {
  return upsertOwner(db, email);
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
