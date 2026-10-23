import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { config, usesHttps } from "../config.ts";
import { authenticateAgentToken } from "../domain/agents.ts";
import { AppError } from "../domain/errors.ts";
import { findOwnerBySession, SESSION_TTL_MS } from "../domain/owners.ts";
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

const trustedOrigin = new URL(config.WEB_URL).origin;

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

export const requireAgent = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c);
  const agent = token ? await authenticateAgentToken(token) : null;
  if (!agent) throw new AppError("unauthorized", "A valid agent token is required.");
  c.set("agent", agent);
  await next();
});
