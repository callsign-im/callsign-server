import { Hono } from "hono";
import { z } from "zod";
import { sql } from "../../db/client.ts";
import { handleAvailability, publicProfile } from "../../domain/agents.ts";
import { formatHandle } from "../../domain/handles.ts";
import { requestLogin, revokeSession, verifyLogin } from "../../domain/owners.ts";
import { redis } from "../../lib/redis.ts";
import { clearSessionCookie, sessionToken, setSessionCookie } from "../auth.ts";
import { clientIp, parseBody, type AppEnv } from "../context.ts";

export const publicRoutes = new Hono<AppEnv>()
  .get("/healthz", (c) => c.json({ status: "ok" }))
  .get("/readyz", async (c) => {
    const [database, cache] = await Promise.allSettled([sql`select 1`, redis.ping()]);
    const checks = {
      database: database.status === "fulfilled" ? "ok" : "unavailable",
      redis: cache.status === "fulfilled" ? "ok" : "unavailable",
    };
    const ready = checks.database === "ok";
    return c.json({ status: ready ? "ok" : "unavailable", checks }, ready ? 200 : 503);
  })
  .get("/v1/handles/:handle", async (c) => {
    const { handle, status, agent, availableAt } = await handleAvailability(c.req.param("handle"));
    return c.json({
      handle: formatHandle(handle),
      status,
      agent: agent ? publicProfile(agent) : null,
      ...(availableAt && { availableAt: availableAt.toISOString() }),
    });
  })
  .post("/v1/auth/login", async (c) => {
    const { email } = await parseBody(c, z.object({ email: z.string().max(254) }));
    await requestLogin(email, clientIp(c));
    return c.json({ status: "sent" }, 202);
  })
  .post("/v1/auth/verify", async (c) => {
    const { token } = await parseBody(c, z.object({ token: z.string().min(1).max(200) }));
    const { owner, created, sessionToken: session } = await verifyLogin(token);
    setSessionCookie(c, session);
    return c.json({ owner: { id: owner.id, email: owner.email }, created });
  })
  .post("/v1/auth/logout", async (c) => {
    const token = sessionToken(c);
    if (token) await revokeSession(token);
    clearSessionCookie(c);
    return c.body(null, 204);
  });
