import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { config } from "../config.ts";
import { exitOnRejectedCredentials } from "../db/client.ts";
import { AppError } from "../domain/errors.ts";
import { logger } from "../lib/logger.ts";
import type { AppEnv } from "./context.ts";
import { agentRoutes } from "./routes/agent.ts";
import { discoveryRoutes } from "./routes/discovery.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { oauthRoutes } from "./routes/oauth.ts";
import { ownerRoutes } from "./routes/owner.ts";
import { publicRoutes } from "./routes/public.ts";
import { registrationRoutes } from "./routes/registration.ts";

const appOrigin = new URL(config.APP_URL).origin;

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(secureHeaders());
  // File uploads arrive base64-encoded through MCP or the files endpoint.
  app.use((c, next) => {
    const large = ["/mcp", "/v1/agent/files"].some(
      (prefix) => c.req.path === prefix || c.req.path.startsWith(`${prefix}/`),
    );
    return bodyLimit({ maxSize: (large ? 8 : 1) * 1024 * 1024 })(c, next);
  });
  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    if (c.req.path === "/healthz" || c.req.path === "/readyz") return;
    logger.info(
      {
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path.startsWith("/mcp/") ? "/mcp/:token" : c.req.path,
        status: c.res.status,
        durationMs: Math.round(performance.now() - started),
      },
      "request",
    );
  });
  app.use(
    "/v1/*",
    cors({
      origin: (origin, c) => {
        if (origin === appOrigin) return origin;
        const open = ["/v1/agent/", "/v1/register", "/v1/handles/", "/v1/stats"].some((p) =>
          c.req.path.startsWith(p),
        );
        return open ? "*" : null;
      },
      credentials: true,
      allowHeaders: ["content-type", "authorization"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 600,
    }),
  );
  app.use("/.well-known/*", cors({ origin: "*" }));
  app.use(
    "/oauth/*",
    cors({
      origin: "*",
      allowHeaders: ["content-type", "authorization"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );
  app.use(
    "/mcp/*",
    cors({
      origin: "*",
      allowHeaders: ["content-type", "authorization", "mcp-protocol-version", "if-none-match"],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      exposeHeaders: ["etag", "www-authenticate"],
    }),
  );

  app.route("/", discoveryRoutes);
  app.route("/", oauthRoutes);
  app.route("/", publicRoutes);
  app.route("/", registrationRoutes);
  app.route("/", agentRoutes);
  app.route("/", mcpRoutes);
  app.route("/", ownerRoutes);

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Route not found." } }, 404));

  app.onError((error, c) => {
    if (error instanceof AppError) {
      const retryAfter =
        error.code === "rate_limited" &&
        typeof error.details === "object" &&
        error.details !== null &&
        "retryAfter" in error.details
          ? String(error.details.retryAfter)
          : undefined;
      if (retryAfter) c.header("retry-after", retryAfter);
      return c.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        error.status,
      );
    }
    if (error instanceof HTTPException) return error.getResponse();
    logger.error({ err: error, requestId: c.get("requestId") }, "unhandled error");
    exitOnRejectedCredentials(error);
    return c.json({ error: { code: "internal", message: "Something went wrong." } }, 500);
  });

  return app;
}
