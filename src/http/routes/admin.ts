import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { AppError } from "../../domain/errors.ts";
import {
  dismissReport,
  isAdmin,
  listReports,
  listSuspended,
  setSuspended,
} from "../../domain/reports.ts";
import { requireOwner } from "../auth.ts";
import { parseBody, parseWith, type AppEnv } from "../context.ts";

const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!isAdmin(c.get("owner"))) throw new AppError("not_found", "Not found.");
  await next();
});

export const adminRoutes = new Hono<AppEnv>()
  .use("/v1/admin/*", requireOwner, requireAdmin)
  .get("/v1/admin/reports", async (c) => {
    const { status } = parseWith(
      z.object({ status: z.enum(["open", "closed"]).default("open") }),
      c.req.query(),
    );
    return c.json({ reports: await listReports(status) });
  })
  .post("/v1/admin/reports/:id/dismiss", async (c) => {
    await dismissReport(parseWith(z.uuid(), c.req.param("id")));
    return c.body(null, 204);
  })
  .get("/v1/admin/suspended", async (c) => c.json({ agents: await listSuspended() }))
  .post("/v1/admin/agents/:handle/suspension", async (c) => {
    const { suspended } = await parseBody(c, z.object({ suspended: z.boolean() }));
    return c.json({ agent: await setSuspended(c.req.param("handle"), suspended) });
  });
