import { and, desc, eq, inArray, lt, ne, type SQL } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import {
  agentNetworks,
  agents,
  owners,
  securityAlerts,
  type Agent,
  type AlertKind,
  type AlertStatus,
  type Owner,
  type SecurityAlert,
} from "../db/schema.ts";
import { enqueue } from "../jobs/queue.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import type { DataKey } from "../lib/encryption.ts";
import { uuidv7 } from "../lib/ids.ts";
import { sendMail } from "../lib/mailer.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import { AppError } from "./errors.ts";
import { freezeAgent, type FreezeVia } from "./freeze.ts";
import { formatHandle } from "./handles.ts";
import { ownerKey } from "./keys.ts";
import { appendLedgerEvent, broadcast } from "./ledger.ts";

const THROTTLE_SECONDS = 3600;
const ALERTS_SHOWN = 50;
const RESOLVED_ALERT_RETENTION_MS = 90 * 86_400_000;

export type AlertDetails = {
  client?: string;
  tokenPrefix?: string;
  network?: string;
  ip?: string;
  userAgent?: string | null;
  messages?: number;
  minutes?: number;
  holds?: number;
};

export type AlertChannel = FreezeVia;

export type AlertView = {
  id: string;
  agent: string | null;
  kind: AlertKind;
  status: AlertStatus;
  title: string;
  description: string;
  details: AlertDetails;
  createdAt: string;
  resolvedAt: string | null;
  resolvedVia: string | null;
};

const detailsContext = (id: string) => `security_alerts.details:${id}`;

function title(kind: AlertKind, handle: string): string {
  switch (kind) {
    case "new_network":
      return `${handle} was used from a new network`;
    case "burst":
      return `${handle} is sending messages unusually fast`;
    case "refresh_token_reused":
    case "code_reused":
      return `A connection to ${handle} may have been copied`;
    case "repeated_holds":
      return `${handle} keeps trying actions you hold for approval`;
  }
}

function description(kind: AlertKind, handle: string, details: AlertDetails): string {
  const client = details.client ? `"${details.client}"` : "a connection";
  switch (kind) {
    case "new_network":
      return `${client} used ${handle} from ${details.network ?? "an address"}, a network it hasn't used before.`;
    case "burst":
      return `${handle} sent ${details.messages ?? "many"} messages in ${details.minutes ?? "a few"} minutes.`;
    case "refresh_token_reused":
      return `${client} presented a refresh token for ${handle} that had already been used, which usually means it was copied. Callsign disconnected it; the app will ask to connect again.`;
    case "code_reused":
      return `A sign-in code for ${client} on ${handle} was used twice, which can mean it was intercepted. Callsign disconnected the connection it created.`;
    case "repeated_holds":
      return `${handle} tried ${details.holds ?? "several"} actions in the last hour that your rules hold for approval. If you don't expect that, freeze it.`;
  }
}

function alertView(key: DataKey, row: SecurityAlert, handle: string | null): AlertView {
  const details = JSON.parse(key.open(row.details, detailsContext(row.id))) as AlertDetails;
  const name = handle ? formatHandle(handle) : "Your agent";
  return {
    id: row.id,
    agent: handle ? formatHandle(handle) : null,
    kind: row.kind,
    status: row.status,
    title: title(row.kind, name),
    description: description(row.kind, name, details),
    details,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedVia: row.resolvedVia,
  };
}

/**
 * Tells the owner something looks off and offers a one-tap freeze. The same alert for the same
 * agent and cause is sent at most once an hour.
 */
export async function raiseAlert(input: {
  agent: Agent;
  kind: AlertKind;
  tokenId?: string | null;
  networkDigest?: string | null;
  details: AlertDetails;
}): Promise<string | null> {
  const { agent, kind, details } = input;
  const cause = input.networkDigest ?? input.tokenId ?? "";
  const fresh = await bestEffort(
    () => redis.set(`alert:${agent.id}:${kind}:${cause}`, "1", "EX", THROTTLE_SECONDS, "NX"),
    "OK",
  );
  if (fresh !== "OK") return null;

  const id = uuidv7();
  const token = randomToken();
  const key = await ownerKey(agent.ownerId);
  const recorded = await db.transaction(async (tx) => {
    await tx.insert(securityAlerts).values({
      id,
      ownerId: agent.ownerId,
      agentId: agent.id,
      tokenId: input.tokenId ?? null,
      kind,
      details: key.seal(JSON.stringify(details), detailsContext(id)),
      networkDigest: input.networkDigest ?? null,
      actionTokenHash: sha256(token),
    });
    await enqueue(tx, "alert.email", { alertId: id, freezeUrl: alertLink(token) });
    await enqueue(tx, "alert.telegram", { alertId: id });
    return appendLedgerEvent(tx, agent, {
      type: "security.alert",
      actor: "system",
      data: { alertId: id, kind, ...(details.client && { client: details.client }) },
    });
  });
  await broadcast([recorded]);
  return id;
}

function alertLink(token: string): string {
  const url = new URL("/freeze", config.APP_URL);
  url.searchParams.set("token", token);
  return url.toString();
}

export async function listAlerts(owner: Owner, options: { open: boolean }): Promise<AlertView[]> {
  const key = await ownerKey(owner.id);
  const rows = await db
    .select({ alert: securityAlerts, handle: agents.handle })
    .from(securityAlerts)
    .leftJoin(agents, eq(agents.id, securityAlerts.agentId))
    .where(
      and(
        eq(securityAlerts.ownerId, owner.id),
        options.open ? eq(securityAlerts.status, "open") : undefined,
      ),
    )
    .orderBy(desc(securityAlerts.createdAt))
    .limit(ALERTS_SHOWN);
  return rows.map((row) => alertView(key, row.alert, row.handle));
}

async function findAlert(where: SQL) {
  const [row] = await db
    .select({ alert: securityAlerts, agent: agents })
    .from(securityAlerts)
    .leftJoin(agents, eq(agents.id, securityAlerts.agentId))
    .where(where);
  return row;
}

async function ownedAlert(ownerId: string, id: string) {
  const found = await findAlert(eq(securityAlerts.id, id));
  if (!found || found.alert.ownerId !== ownerId) throw new AppError("not_found", "No such alert.");
  return found;
}

async function resolve(
  alert: SecurityAlert,
  status: Extract<AlertStatus, "acknowledged" | "frozen">,
  via: AlertChannel,
): Promise<void> {
  await db
    .update(securityAlerts)
    .set({ status, resolvedVia: via, resolvedAt: new Date() })
    .where(
      and(
        eq(securityAlerts.id, alert.id),
        inArray(securityAlerts.status, status === "frozen" ? ["open", "acknowledged"] : ["open"]),
      ),
    );
}

/** "It was me": the network becomes known and the alert is closed. */
async function acknowledge(alert: SecurityAlert, via: AlertChannel): Promise<void> {
  if (alert.status === "frozen" || alert.status === "resolved") {
    throw new AppError("conflict", "This alert was already handled.");
  }
  if (alert.kind === "new_network" && alert.agentId && alert.networkDigest) {
    await db
      .update(agentNetworks)
      .set({ status: "known" })
      .where(
        and(
          eq(agentNetworks.agentId, alert.agentId),
          eq(agentNetworks.networkDigest, alert.networkDigest),
        ),
      );
  }
  await resolve(alert, "acknowledged", via);
}

async function freezeFor(alert: SecurityAlert, agent: Agent | null, via: AlertChannel) {
  if (!agent) throw new AppError("not_found", "That agent no longer exists.");
  const frozen = await freezeAgent(agent, { actor: "owner", via, alertId: alert.id });
  await resolve(alert, "frozen", via);
  return frozen;
}

export async function acknowledgeAlert(owner: Owner, id: string, via: AlertChannel) {
  const { alert } = await ownedAlert(owner.id, id);
  await acknowledge(alert, via);
}

export async function freezeFromAlert(
  owner: Owner,
  id: string,
  via: AlertChannel,
  agentId?: string,
) {
  const { alert, agent } = await ownedAlert(owner.id, id);
  if (agentId && alert.agentId !== agentId) throw new AppError("not_found", "No such alert.");
  return freezeFor(alert, agent, via);
}

export type AlertLinkView = AlertView & { frozen: boolean };

async function byLink(token: string) {
  const found = await findAlert(eq(securityAlerts.actionTokenHash, sha256(token)));
  if (!found) throw new AppError("not_found", "This link isn't valid anymore.");
  return found;
}

/** Opening the link only shows the alert; acting on it takes a deliberate POST. */
export async function alertLinkView(token: string): Promise<AlertLinkView> {
  const { alert, agent } = await byLink(token);
  const key = await ownerKey(alert.ownerId);
  return { ...alertView(key, alert, agent?.handle ?? null), frozen: Boolean(agent?.frozenAt) };
}

export async function actOnAlertLink(
  token: string,
  action: "freeze" | "acknowledge",
): Promise<AlertLinkView> {
  const { alert, agent } = await byLink(token);
  if (action === "freeze") await freezeFor(alert, agent, "email");
  else await acknowledge(alert, "email");
  return alertLinkView(token);
}

export async function sendAlertEmail({
  alertId,
  freezeUrl,
}: {
  alertId: string;
  freezeUrl: string;
}): Promise<void> {
  const [found] = await db
    .select({ alert: securityAlerts, handle: agents.handle, email: owners.email })
    .from(securityAlerts)
    .innerJoin(owners, eq(owners.id, securityAlerts.ownerId))
    .leftJoin(agents, eq(agents.id, securityAlerts.agentId))
    .where(eq(securityAlerts.id, alertId));
  if (!found) return;
  const view = alertView(await ownerKey(found.alert.ownerId), found.alert, found.handle);
  const name = view.agent ?? "your agent";
  const { ip, userAgent, network } = view.details;
  await sendMail({
    to: found.email,
    subject: view.title,
    text: [
      view.description,
      ...(ip
        ? [
            "",
            `Address: ${ip}${network ? ` (${network})` : ""}`,
            ...(userAgent ? [`App: ${userAgent}`] : []),
          ]
        : []),
      "",
      `If it wasn't you or your agent, freeze ${name}. Every call it makes is refused until you unfreeze it, and nothing is deleted:`,
      "",
      freezeUrl,
      "",
      view.kind === "new_network"
        ? `If it was you, open the same link and choose "It was me" so Callsign learns this network.`
        : `If it was you, open the same link and choose "It was me".`,
      "",
      "Don't forward this email: its link acts for you.",
    ].join("\n"),
  });
}

export async function alertForTelegram(alertId: string) {
  const [found] = await db
    .select({ alert: securityAlerts, handle: agents.handle, chatId: owners.telegramChatId })
    .from(securityAlerts)
    .innerJoin(owners, eq(owners.id, securityAlerts.ownerId))
    .leftJoin(agents, eq(agents.id, securityAlerts.agentId))
    .where(eq(securityAlerts.id, alertId));
  if (!found?.chatId) return null;
  const view = alertView(await ownerKey(found.alert.ownerId), found.alert, found.handle);
  return { chatId: found.chatId, view };
}

export async function pruneAlerts(): Promise<void> {
  const before = new Date(Date.now() - RESOLVED_ALERT_RETENTION_MS);
  await db
    .delete(securityAlerts)
    .where(and(ne(securityAlerts.status, "open"), lt(securityAlerts.resolvedAt, before)));
}
