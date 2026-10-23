import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { config, usesHttps } from "../../config.ts";
import { MAX_DESCRIPTION_LENGTH, PRODUCTS } from "../../domain/agents.ts";
import {
  authorizationServerMetadata,
  authorizationView,
  decideAuthorization,
  exchangeToken,
  issuer,
  mcpResource,
  OAuthError,
  protectedResourceMetadata,
  registerClient,
  revokeToken,
  startAuthorization,
  type ClientCredentials,
} from "../../domain/oauth.ts";
import { rateLimit } from "../../lib/rate-limit.ts";
import { requireOwner } from "../auth.ts";
import { clientIp, parseBody, parseWith, type AppEnv } from "../context.ts";

const NONCE_COOKIE = "callsign_oauth";
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

const decisionBody = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("deny") }),
  z.object({
    decision: z.literal("approve"),
    agent: z.string().min(1).max(64).optional(),
    create: z
      .object({
        handle: z.string().min(1).max(64),
        displayName: z.string().max(80).optional(),
        description: z.string().min(1).max(MAX_DESCRIPTION_LENGTH),
        product: z.enum(PRODUCTS),
        rules: z.string().max(2000).nullable().optional(),
      })
      .optional(),
  }),
]);

function oauthError(c: Context, error: OAuthError) {
  return c.json({ error: error.error, error_description: error.message }, error.status, NO_STORE);
}

async function oauthEndpoint(c: Context, action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof OAuthError) return oauthError(c, error);
    throw error;
  }
}

async function formParams(c: Context): Promise<Record<string, string | undefined>> {
  const body: Record<string, unknown> = (c.req.header("content-type") ?? "").includes("json")
    ? await c.req.json<Record<string, unknown>>().catch(() => ({}))
    : await c.req.parseBody();
  return Object.fromEntries(
    Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function basicCredentials(c: Context): ClientCredentials {
  const match = /^Basic\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
  if (!match?.[1]) return undefined;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const split = decoded.indexOf(":");
  if (split < 0) return undefined;
  return {
    id: decodeURIComponent(decoded.slice(0, split)),
    secret: decodeURIComponent(decoded.slice(split + 1)),
  };
}

const noncePath = (requestId: string) => `/v1/oauth/requests/${requestId}`;

export const oauthRoutes = new Hono<AppEnv>()
  .get("/.well-known/oauth-authorization-server", (c) => c.json(authorizationServerMetadata()))
  .get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(issuer)))
  .get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json(protectedResourceMetadata(mcpResource)),
  )
  .post("/oauth/register", (c) =>
    oauthEndpoint(c, async () => {
      await rateLimit(`oauth-register:${clientIp(c)}`, 30, 3600);
      const body = await c.req.json<unknown>().catch(() => null);
      return c.json(await registerClient(body), 201, NO_STORE);
    }),
  )
  .get("/oauth/authorize", async (c) => {
    await rateLimit(`oauth-authorize:${clientIp(c)}`, 60, 600);
    let start;
    try {
      start = await startAuthorization(c.req.query());
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      return c.text(
        `Callsign couldn't start this connection: ${error.message} Go back to your app and try again.`,
        400,
      );
    }
    if (start.kind === "redirect") return c.redirect(start.url, 302);
    setCookie(c, NONCE_COOKIE, start.nonce, {
      httpOnly: true,
      secure: usesHttps,
      sameSite: "Lax",
      path: noncePath(start.requestId),
      maxAge: 600,
    });
    const consent = new URL("/oauth/consent", config.APP_URL);
    consent.searchParams.set("request", start.requestId);
    return c.redirect(consent.toString(), 302);
  })
  .post("/oauth/token", (c) =>
    oauthEndpoint(c, async () =>
      c.json(await exchangeToken(await formParams(c), basicCredentials(c)), 200, NO_STORE),
    ),
  )
  .post("/oauth/revoke", (c) =>
    oauthEndpoint(c, async () => {
      await revokeToken(await formParams(c), basicCredentials(c));
      return c.body(null, 200);
    }),
  )
  .use("/v1/oauth/*", requireOwner)
  .get("/v1/oauth/requests/:id", async (c) => {
    const id = parseWith(z.uuid(), c.req.param("id"));
    return c.json(await authorizationView(c.get("owner"), id, getCookie(c, NONCE_COOKIE)));
  })
  .post("/v1/oauth/requests/:id", async (c) => {
    const id = parseWith(z.uuid(), c.req.param("id"));
    const input = await parseBody(c, decisionBody);
    const redirectTo = await decideAuthorization(
      c.get("owner"),
      id,
      getCookie(c, NONCE_COOKIE),
      input,
    );
    deleteCookie(c, NONCE_COOKIE, { path: noncePath(id), secure: usesHttps });
    return c.json({ redirectTo });
  });
