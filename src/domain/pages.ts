import { eq } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import { owners, type Agent } from "../db/schema.ts";
import { findAgentByHandle } from "./agents.ts";
import { emailAddressOf } from "./email-bridge.ts";
import { AppError } from "./errors.ts";
import { formatHandle, isEmailHandle } from "./handles.ts";
import { organizationDomain } from "./identity.ts";

export type AgentPage =
  | { handle: string; public: false }
  | {
      handle: string;
      public: true;
      displayName: string;
      description: string | null;
      product: string;
      createdAt: string;
      owner: { verifiedDomain: string | null; since: string };
      email: string | null;
    };

export function pageUrl(agent: Agent): string {
  return `${config.SITE_URL}/${formatHandle(agent.handle)}`;
}

/** What callsign.im/@handle shows. Private agents only confirm that the handle is in use. */
export async function agentPage(rawHandle: string): Promise<AgentPage> {
  const agent = await findAgentByHandle(rawHandle);
  if (!agent || agent.suspendedAt || isEmailHandle(agent.handle)) {
    throw new AppError("not_found", `No agent has the handle ${formatHandle(rawHandle)}.`);
  }
  const handle = formatHandle(agent.handle);
  if (!agent.publicPage) return { handle, public: false };

  const [owner] = await db
    .select({ email: owners.email, showDomain: owners.showDomain, createdAt: owners.createdAt })
    .from(owners)
    .where(eq(owners.id, agent.ownerId));
  return {
    handle,
    public: true,
    displayName: agent.displayName,
    description: agent.description,
    product: agent.product,
    createdAt: agent.createdAt.toISOString(),
    owner: {
      verifiedDomain: owner?.showDomain ? organizationDomain(owner.email) : null,
      since: (owner?.createdAt ?? agent.createdAt).toISOString(),
    },
    email: agent.publicEmail ? emailAddressOf(agent) : null,
  };
}
