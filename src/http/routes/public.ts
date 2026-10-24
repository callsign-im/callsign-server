import { Hono } from "hono";
import { z } from "zod";
import { sql } from "../../db/client.ts";
import { handleAvailability, publicProfile } from "../../domain/agents.ts";
import { AppError } from "../../domain/errors.ts";
import { formatHandle } from "../../domain/handles.ts";
import { acceptInvitations, invitationPreview } from "../../domain/invitations.ts";
import { requestLogin, revokeSession, verifyLogin } from "../../domain/owners.ts";
import { answerByLink, answerLinkView, MAX_OPTIONS } from "../../domain/questions.ts";
import { networkStats } from "../../domain/stats.ts";
import { handleTelegramUpdate, type TelegramUpdate } from "../../domain/telegram.ts";
import { safeEqual } from "../../lib/crypto.ts";
import { logger } from "../../lib/logger.ts";
import { redis } from "../../lib/redis.ts";
import { telegramEnabled, telegramWebhookSecret } from "../../lib/telegram.ts";
import { clearSessionCookie, sessionToken, setSessionCookie } from "../auth.ts";
import { clientIp, parseBody, parseWith, type AppEnv } from "../context.ts";

const answerToken = z.string().min(1).max(100);

export const answerBody = z
  .object({
    option: z
      .number()
      .int()
      .min(0)
      .max(MAX_OPTIONS - 1)
      .optional(),
    answer: z.string().min(1).max(4000).optional(),
  })
  .refine((body) => (body.option === undefined) !== (body.answer === undefined), {
    message: "Send either an option or an answer.",
  });

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
  .get("/v1/stats", async (c) =>
    c.json(await networkStats(), 200, { "cache-control": "public, max-age=300" }),
  )
  .post("/v1/telegram/webhook", async (c) => {
    const secret = c.req.header("x-telegram-bot-api-secret-token") ?? "";
    if (!telegramEnabled() || !safeEqual(secret, telegramWebhookSecret())) {
      throw new AppError("not_found", "Not found.");
    }
    const update = (await c.req.json().catch(() => ({}))) as TelegramUpdate;
    // Telegram retries anything but a 200, so failures are logged instead of returned.
    await handleTelegramUpdate(update).catch((err: unknown) =>
      logger.error({ err }, "telegram update failed"),
    );
    return c.json({ ok: true });
  })
  .get("/v1/answers/:token", async (c) =>
    c.json(await answerLinkView(parseWith(answerToken, c.req.param("token")))),
  )
  .post("/v1/answers/:token", async (c) => {
    const body = await parseBody(c, answerBody);
    const reply = body.option !== undefined ? { option: body.option } : (body.answer ?? "");
    return c.json(await answerByLink(parseWith(answerToken, c.req.param("token")), reply));
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
  .get("/v1/invitations/:token", async (c) =>
    c.json(await invitationPreview(parseWith(z.string().min(1).max(200), c.req.param("token")))),
  )
  .post("/v1/auth/login", async (c) => {
    const { email } = await parseBody(c, z.object({ email: z.string().max(254) }));
    await requestLogin(email, clientIp(c));
    return c.json({ status: "sent" }, 202);
  })
  .post("/v1/auth/verify", async (c) => {
    const { token } = await parseBody(c, z.object({ token: z.string().min(1).max(200) }));
    const { owner, created, sessionToken: session } = await verifyLogin(token);
    if (created) await acceptInvitations(owner);
    setSessionCookie(c, session);
    return c.json({ owner: { id: owner.id, email: owner.email }, created });
  })
  .post("/v1/auth/logout", async (c) => {
    const token = sessionToken(c);
    if (token) await revokeSession(token);
    clearSessionCookie(c);
    return c.body(null, 204);
  });
