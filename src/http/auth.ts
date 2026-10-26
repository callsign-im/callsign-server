import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { config, usesHttps } from "../config.ts";
import type { Agent } from "../db/schema.ts";
import { assertAgentActive } from "../domain/access.ts";
import { authenticateAgentCredential } from "../domain/agents.ts";
import { AppError } from "../domain/errors.ts";
import { formatHandle } from "../domain/handles.ts";
import { findOwnerSession, SESSION_TTL_MS } from "../domain/owners.ts";
import { assertStepUp } from "../domain/passkeys.ts";
import { findRegistrationByAgentToken, maskEmail, pendingView } from "../domain/registrations.ts";
import { noteSighting, type Seen } from "../domain/sightings.ts";
import { bearerToken, seenFrom, type AppEnv } from "./context.ts";

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
  // Route groups share path prefixes, so this can run twice for one request.
  if (c.get("owner") as AppEnv["Variables"]["owner"] | undefined) return next();
  const origin = c.req.header("origin");
  if (c.req.method !== "GET" && origin && origin !== trustedOrigin) {
    throw new AppError("forbidden", "Cross-origin request rejected.");
  }
  const token = sessionToken(c);
  const found = token ? await findOwnerSession(token) : null;
  if (!found) throw new AppError("unauthorized", "Sign in to continue.");
  c.set("owner", found.owner);
  c.set("session", found.session);
  await next();
});

/** Passkey ceremonies only run from the dashboard itself, never from a request without an Origin. */
export const requireAppOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.header("origin") !== trustedOrigin) {
    throw new AppError("forbidden", "Cross-origin request rejected.");
  }
  await next();
});

/** Owners with a passkey confirm sensitive changes with it; runs after requireOwner. */
export const requireStepUp = createMiddleware<AppEnv>(async (c, next) => {
  await assertStepUp(c.get("owner").id, c.get("session"));
  await next();
});

export async function agentFromToken(token: string | undefined): Promise<Agent> {
  return (await agentCredential(token)).agent;
}

export async function agentCredential(
  token: string | undefined,
  seen?: Seen,
): Promise<{ agent: Agent; tokenId: string; client: string }> {
  const credential = token ? await authenticateAgentCredential(token) : null;
  if (credential) {
    // Recorded before the checks below, so the owner also sees calls refused while frozen.
    if (seen) await noteSighting(credential.agent, credential.tokenId, seen);
    assertAgentActive(credential.agent);
    return credential;
  }
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
  const seen = seenFrom(c);
  const { agent, tokenId, client } = await agentCredential(bearerToken(c), seen);
  c.set("seen", seen);
  c.set("agent", agent);
  c.set("tokenId", tokenId);
  c.set("client", client);
  await next();
});
