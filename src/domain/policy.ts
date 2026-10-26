import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.ts";
import { agents, type Agent, type Owner } from "../db/schema.ts";
import { formatHandle } from "./handles.ts";
import { appendLedgerEvent, broadcast } from "./ledger.ts";
import type { OwnerSession } from "./owners.ts";
import { assertStepUp } from "./passkeys.ts";

export const MAX_HOLD_HOURS = 168;

const holdsSchema = z.object({
  firstContact: z.boolean().default(false),
  attachments: z.boolean().default(false),
  groups: z.boolean().default(false),
  invitePerson: z.boolean().default(false),
  newNetwork: z.boolean().default(false),
  toolWrites: z.boolean().default(false),
  hourlyMessages: z.number().int().min(1).max(1000).nullable().default(null),
});

const policySchema = z.object({
  holds: holdsSchema.default(holdsSchema.parse({})),
  holdHours: z.number().int().min(1).max(MAX_HOLD_HOURS).default(24),
});

export type Policy = z.infer<typeof policySchema>;
export type Holds = Policy["holds"];

// Spelled out without defaults, so a patch only touches the fields it names.
export const policyPatch = z.object({
  holds: z
    .object({
      firstContact: z.boolean(),
      attachments: z.boolean(),
      groups: z.boolean(),
      invitePerson: z.boolean(),
      newNetwork: z.boolean(),
      toolWrites: z.boolean(),
      hourlyMessages: z.number().int().min(1).max(1000).nullable(),
    })
    .partial()
    .optional(),
  holdHours: z.number().int().min(1).max(MAX_HOLD_HOURS).optional(),
});

export type PolicyPatch = z.infer<typeof policyPatch>;

/** The stored policy with defaults filled in. Anything unreadable falls back to no holds. */
export function readPolicy(agent: Pick<Agent, "policy">): Policy {
  const parsed = policySchema.safeParse(agent.policy ?? {});
  return parsed.success ? parsed.data : policySchema.parse({});
}

export function holdsAnything(policy: Policy): boolean {
  const { hourlyMessages, ...switches } = policy.holds;
  return hourlyMessages !== null || Object.values(switches).some(Boolean);
}

// Turning a hold off or raising the hourly limit loosens the rules; tightening them never
// needs a passkey.
function loosens(before: Policy, after: Policy): boolean {
  const switches = [
    "firstContact",
    "attachments",
    "groups",
    "invitePerson",
    "newNetwork",
    "toolWrites",
  ] as const;
  if (switches.some((name) => before.holds[name] && !after.holds[name])) return true;
  const was = before.holds.hourlyMessages;
  const now = after.holds.hourlyMessages;
  if (was !== null && (now === null || now > was)) return true;
  return false;
}

export async function updatePolicy(
  owner: Owner,
  session: OwnerSession,
  agent: Agent,
  patch: PolicyPatch,
): Promise<{ agent: Agent; policy: Policy }> {
  const before = readPolicy(agent);
  const after = policySchema.parse({
    holds: { ...before.holds, ...patch.holds },
    holdHours: patch.holdHours ?? before.holdHours,
  });
  if (loosens(before, after)) await assertStepUp(owner.id, session);

  const changed = Object.keys(after.holds).filter(
    (name) => before.holds[name as keyof Holds] !== after.holds[name as keyof Holds],
  );
  if (before.holdHours !== after.holdHours) changed.push("holdHours");
  if (changed.length === 0) return { agent, policy: before };

  const { row, recorded } = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(agents)
      .set({ policy: after })
      .where(eq(agents.id, agent.id))
      .returning();
    if (!row) throw new Error(`${formatHandle(agent.handle)} disappeared while saving its rules`);
    const recorded = await appendLedgerEvent(tx, row, {
      type: "policy.updated",
      actor: "owner",
      data: { changed, holds: after.holds, holdHours: after.holdHours },
    });
    return { row, recorded };
  });
  await broadcast([recorded]);
  return { agent: row, policy: after };
}
