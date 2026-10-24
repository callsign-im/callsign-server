import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { config, usesHttps } from "../config.ts";
import { authenticateAgentCredential } from "../domain/agents.ts";
import type { Agent } from "../db/schema.ts";
import { AppError } from "../domain/errors.ts";
import { formatHandle } from "../domain/handles.ts";
import { findOwnerBySession, SESSION_TTL_MS } from "../domain/owners.ts";
import { findRegistrationByAgentToken, maskEmail, pendingView } from "../domain/registrations.ts";
import { bearerToken, type AppEnv } from "./context.ts";

export const SESSION_COOKIE = "callsign_session";

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: usesHttps,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: usesHttps });
}

export function sessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

const trustedOrigin = new URL(config.APP_URL).origin;

export const requireOwner = createMiddleware<AppEnv>(async (c, next) => {
  const origin = c.req.header("origin");
  if (c.req.method !== "GET" && origin && origin !== trustedOrigin) {
    throw new AppError("forbidden", "Cross-origin request rejected.");
  }
  const token = sessionToken(c);
  const owner = token ? await findOwnerBySession(token) : null;
  if (!owner) throw new AppError("unauthorized", "Sign in to continue.");
  c.set("owner", owner);
  await next();
});

export async function agentFromToken(token: string | undefined): Promise<Agent> {
  return (await agentCredential(token)).agent;
}

export async function agentCredential(
  token: string | undefined,
): Promise<{ agent: Agent; tokenId: string; client: string }> {
  const credential = token ? await authenticateAgentCredential(token) : null;
  if (credential?.agent.suspendedAt) {
    throw new AppError(
      "forbidden",
      `${formatHandle(credential.agent.handle)} is suspended after reports of abuse. Its owner received an email explaining how to appeal.`,
    );
  }
  if (credential) return credential;
  const pending = token ? await findRegistrationByAgentToken(token) : undefined;
  if (pending) {
    throw new AppError(
      "pending_approval",
      `${formatHandle(pending.handle)} is waiting for its owner to approve the registration (email sent to ${maskEmail(pending.ownerEmail)}). Poll GET /v1/register/status until it is active.`,
      pendingView(pending),
    );
  }
  throw new AppError("unauthorized", "A valid agent token is required.");
}

export const requireAgent = createMiddleware<AppEnv>(async (c, next) => {
  const { agent, tokenId, client } = await agentCredential(bearerToken(c));
  c.set("agent", agent);
  c.set("tokenId", tokenId);
  c.set("client", client);
  await next();
});
