import { createHash } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import {
  agentTokens,
  agents,
  oauthAuthorizations,
  oauthClients,
  type Agent,
  type OAuthAuthorization,
  type Owner,
} from "../db/schema.ts";
import { randomToken, safeEqual, sha256 } from "../lib/crypto.ts";
import { uuidv7 } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import { fetchPublicJson } from "../lib/safe-fetch.ts";
import {
  createAgent,
  currentLedgerSeq,
  getOwnedAgent,
  listOwnerAgents,
  publicProfile,
  revokeAgentToken,
  revokeTokens,
  type Product,
  type RevokeReason,
} from "./agents.ts";
import { raiseAlert } from "./alerts.ts";
import { AppError } from "./errors.ts";
import { formatHandle } from "./handles.ts";
import { connectInvitations } from "./invitations.ts";
import { appendLedgerEvent, broadcast } from "./ledger.ts";
import type { OwnerSession } from "./owners.ts";
import { assertStepUp } from "./passkeys.ts";

export const OAUTH_SCOPE = "agent";
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_MS = 90 * 86_400_000;
const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 2 * 60_000;
const CLIENT_CACHE_SECONDS = { min: 300, max: 86_400, fallback: 3600 };

const AUTH_METHODS = ["none", "client_secret_basic", "client_secret_post"];
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export const issuer = new URL(config.PUBLIC_API_URL).origin;
export const mcpResource = `${issuer}/mcp`;
export const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`;

export class OAuthError extends Error {
  readonly error: string;
  readonly status: 400 | 401;

  constructor(error: string, description: string, status: 400 | 401 = 400) {
    super(description);
    this.name = "OAuthError";
    this.error = error;
    this.status = status;
  }
}

export type OAuthClient = {
  id: string;
  name: string;
  redirectUris: string[];
  secretHash: string | null;
  verified: boolean;
};

export function authorizationServerMetadata() {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: GRANT_TYPES,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: AUTH_METHODS,
    scopes_supported: [OAUTH_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: new URL("/llms-full.txt", config.SITE_URL).toString(),
  };
}

export function protectedResourceMetadata(resource: string) {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Callsign",
    resource_documentation: new URL("/llms-full.txt", config.SITE_URL).toString(),
  };
}

export function isAllowedRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (raw.includes("#")) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !BLOCKED_SCHEMES.has(url.protocol);
}

// Native apps pick a free port when they start (RFC 8252 section 7.3), so loopback redirects match on any port.
function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    return (
      a.protocol === "http:" &&
      b.protocol === "http:" &&
      LOOPBACK_HOSTS.has(a.hostname) &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

function canonicalResource(raw: string | undefined): string | null {
  if (!raw) return mcpResource;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash || url.search) return null;
  const value = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return value === mcpResource || value === issuer ? value : null;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const registrationSchema = z.object({
  redirect_uris: z.array(z.string().max(2048)).min(1).max(10),
  client_name: z.string().trim().min(1).max(100).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

export async function registerClient(input: unknown) {
  const parsed = registrationSchema.safeParse(input);
  if (!parsed.success) {
    throw new OAuthError(
      "invalid_client_metadata",
      parsed.error.issues[0]?.message ?? "Invalid client metadata.",
    );
  }
  const { redirect_uris, client_name, grant_types, response_types } = parsed.data;
  const method = parsed.data.token_endpoint_auth_method ?? "none";
  if (!AUTH_METHODS.includes(method)) {
    throw new OAuthError(
      "invalid_client_metadata",
      `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}.`,
    );
  }
  if (grant_types?.some((grant) => !GRANT_TYPES.includes(grant))) {
    throw new OAuthError(
      "invalid_client_metadata",
      "Only authorization_code and refresh_token are supported.",
    );
  }
  if (response_types?.some((type) => type !== "code")) {
    throw new OAuthError("invalid_client_metadata", "Only the code response type is supported.");
  }
  const rejected = redirect_uris.find((uri) => !isAllowedRedirectUri(uri));
  if (rejected) {
    throw new OAuthError(
      "invalid_redirect_uri",
      `${rejected} is not allowed: use https, a loopback http address or an app scheme, without a fragment.`,
    );
  }

  const id = randomToken("cli");
  const secret = method === "none" ? null : randomToken("css");
  const name = client_name ?? "Unnamed app";
  const [client] = await db
    .insert(oauthClients)
    .values({ id, name, redirectUris: redirect_uris, secretHash: secret ? sha256(secret) : null })
    .returning();
  if (!client) throw new Error("client insert returned no row");
  return {
    client_id: id,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: name,
    redirect_uris,
    grant_types: GRANT_TYPES,
    response_types: ["code"],
    token_endpoint_auth_method: method,
    ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
  };
}

const metadataDocument = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(100),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(20),
  token_endpoint_auth_method: z.string().optional(),
});

// Client ID Metadata Documents: the client_id is an https URL serving the client's own metadata.
async function metadataClient(clientId: string): Promise<OAuthClient | null> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.pathname === "/" || url.hash || url.username || url.password) return null;

  const cacheKey = `oauth-client:${sha256(clientId)}`;
  const cached = await bestEffort(() => redis.get(cacheKey), null);
  if (cached) return JSON.parse(cached) as OAuthClient;

  let document;
  try {
    document = await fetchPublicJson(url);
  } catch (err) {
    logger.info({ err, clientId }, "client metadata document unavailable");
    return null;
  }
  const parsed = metadataDocument.safeParse(document.body);
  if (!parsed.success || parsed.data.client_id !== clientId) return null;
  if ((parsed.data.token_endpoint_auth_method ?? "none") !== "none") return null;

  const client: OAuthClient = {
    id: clientId,
    name: parsed.data.client_name,
    redirectUris: parsed.data.redirect_uris.filter(isAllowedRedirectUri),
    secretHash: null,
    verified: true,
  };
  const ttl = Math.min(
    Math.max(document.maxAge ?? CLIENT_CACHE_SECONDS.fallback, CLIENT_CACHE_SECONDS.min),
    CLIENT_CACHE_SECONDS.max,
  );
  await bestEffort(() => redis.set(cacheKey, JSON.stringify(client), "EX", ttl), null);
  return client;
}

export async function findClient(clientId: string): Promise<OAuthClient | null> {
  if (clientId.startsWith("https://")) return metadataClient(clientId);
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId));
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    redirectUris: row.redirectUris,
    secretHash: row.secretHash,
    verified: false,
  };
}

function redirectWith(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [name, value] of Object.entries(params)) {
    if (value) url.searchParams.set(name, value);
  }
  url.searchParams.set("iss", issuer);
  return url.toString();
}

export type AuthorizationStart =
  { kind: "consent"; requestId: string; nonce: string } | { kind: "redirect"; url: string };

// Problems found before the redirect URI is trusted are shown to the user instead of redirected.
export async function startAuthorization(
  query: Record<string, string | undefined>,
): Promise<AuthorizationStart> {
  const clientId = query.client_id;
  if (!clientId) throw new OAuthError("invalid_request", "The request has no client_id.");
  const client = await findClient(clientId);
  if (!client) throw new OAuthError("invalid_client", "This app isn't registered with Callsign.");
  const redirectUri =
    query.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !client.redirectUris.some((uri) => redirectMatches(uri, redirectUri))) {
    throw new OAuthError(
      "invalid_request",
      "The redirect_uri doesn't match the app's registration.",
    );
  }

  const fail = (error: string, description: string): AuthorizationStart => ({
    kind: "redirect",
    url: redirectWith(redirectUri, { error, error_description: description, state: query.state }),
  });
  if (query.response_type !== "code") {
    return fail("unsupported_response_type", "Only response_type=code is supported.");
  }
  if ((query.state?.length ?? 0) > 1024) {
    return fail("invalid_request", "state is limited to 1024 characters.");
  }
  if (
    !query.code_challenge ||
    query.code_challenge_method !== "S256" ||
    !PKCE_CHALLENGE.test(query.code_challenge)
  ) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  const resource = canonicalResource(query.resource);
  if (!resource) return fail("invalid_target", `Tokens can only be issued for ${mcpResource}.`);

  const nonce = randomToken();
  const id = uuidv7();
  await db.insert(oauthAuthorizations).values({
    id,
    clientId: client.id,
    clientName: client.name,
    redirectUri,
    state: query.state ?? null,
    codeChallenge: query.code_challenge,
    resource,
    nonceHash: sha256(nonce),
    expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
  });
  return { kind: "consent", requestId: id, nonce };
}

// The nonce cookie ties the request to the browser that started it, so a forwarded consent link is useless.
async function pendingAuthorization(
  id: string,
  nonce: string | undefined,
): Promise<OAuthAuthorization> {
  const [row] = await db
    .select()
    .from(oauthAuthorizations)
    .where(
      and(
        eq(oauthAuthorizations.id, id),
        isNull(oauthAuthorizations.codeHash),
        gt(oauthAuthorizations.expiresAt, new Date()),
      ),
    );
  if (!row) {
    throw new AppError("not_found", "This connection request expired. Start again from your app.");
  }
  if (!nonce || !safeEqual(sha256(nonce), row.nonceHash)) {
    throw new AppError(
      "forbidden",
      "Open this page in the browser where you started connecting your app.",
    );
  }
  return row;
}

function redirectTarget(redirectUri: string) {
  const url = new URL(redirectUri);
  const local = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  return { host: url.host || url.protocol.replace(/:$/, ""), local };
}

export async function authorizationView(owner: Owner, id: string, nonce: string | undefined) {
  const row = await pendingAuthorization(id, nonce);
  const owned = await listOwnerAgents(owner.id);
  const verified = row.clientId.startsWith("https://");
  return {
    id: row.id,
    client: {
      name: row.clientName,
      verifiedDomain: verified ? new URL(row.clientId).hostname : null,
      redirect: redirectTarget(row.redirectUri),
    },
    expiresAt: row.expiresAt.toISOString(),
    agents: owned.map((agent) => ({
      ...publicProfile(agent),
      primary: agent.primary,
      frozen: agent.frozenAt !== null,
    })),
  };
}

export type AuthorizationDecision =
  | { decision: "deny" }
  | {
      decision: "approve";
      agent?: string | undefined;
      create?:
        | {
            handle: string;
            displayName?: string | undefined;
            description?: string | undefined;
            product: Product;
            rules?: string | null | undefined;
          }
        | undefined;
    };

export async function decideAuthorization(
  owner: Owner,
  session: OwnerSession,
  id: string,
  nonce: string | undefined,
  input: AuthorizationDecision,
): Promise<string> {
  const row = await pendingAuthorization(id, nonce);
  if (input.decision === "approve") await assertStepUp(owner.id, session);
  if (input.decision === "deny") {
    await db.delete(oauthAuthorizations).where(eq(oauthAuthorizations.id, row.id));
    return redirectWith(row.redirectUri, {
      error: "access_denied",
      error_description: "The owner declined the connection.",
      state: row.state,
    });
  }

  let agent: Agent;
  if (input.create) {
    agent = await createAgent(owner, input.create);
    await connectInvitations(agent);
  } else if (input.agent) agent = await getOwnedAgent(owner.id, input.agent);
  else throw new AppError("invalid_input", "Choose an agent or create a new one.");
  if (agent.frozenAt) {
    throw new AppError("conflict", `${formatHandle(agent.handle)} is frozen. Unfreeze it first.`);
  }

  const code = randomToken();
  const [granted] = await db
    .update(oauthAuthorizations)
    .set({
      codeHash: sha256(code),
      agentId: agent.id,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    })
    .where(and(eq(oauthAuthorizations.id, row.id), isNull(oauthAuthorizations.codeHash)))
    .returning({ id: oauthAuthorizations.id });
  if (!granted) throw new AppError("conflict", "This connection request was already answered.");
  return redirectWith(row.redirectUri, { code, state: row.state });
}

export type ClientCredentials = { id: string; secret: string } | undefined;

async function authenticateClient(
  params: Record<string, string | undefined>,
  basic: ClientCredentials,
): Promise<OAuthClient> {
  const clientId = basic?.id ?? params.client_id;
  const client = clientId ? await findClient(clientId) : null;
  if (!client) throw new OAuthError("invalid_client", "Unknown client.", 401);
  if (client.secretHash) {
    const secret = basic?.secret ?? params.client_secret;
    if (!secret || !safeEqual(sha256(secret), client.secretHash)) {
      throw new OAuthError("invalid_client", "Client authentication failed.", 401);
    }
  }
  return client;
}

function tokenResponse(access: string, refresh: string) {
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    scope: OAUTH_SCOPE,
  };
}

function freshTokens() {
  const access = randomToken("csk");
  const refresh = randomToken("csr");
  const now = Date.now();
  return {
    access,
    refresh,
    fields: {
      tokenHash: sha256(access),
      prefix: access.slice(0, 12),
      expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
      refreshTokenHash: sha256(refresh),
      refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
    },
  };
}

export async function exchangeToken(
  params: Record<string, string | undefined>,
  basic: ClientCredentials,
) {
  const client = await authenticateClient(params, basic);
  switch (params.grant_type) {
    case "authorization_code":
      return redeemCode(client, params);
    case "refresh_token":
      return refreshTokens(client, params);
    default:
      throw new OAuthError(
        "unsupported_grant_type",
        "Use the authorization_code or refresh_token grant.",
      );
  }
}

async function redeemCode(client: OAuthClient, params: Record<string, string | undefined>) {
  const { code, code_verifier: verifier, redirect_uri: redirectUri, resource } = params;
  if (!code || !verifier) {
    throw new OAuthError("invalid_request", "code and code_verifier are required.");
  }
  const codeHash = sha256(code);
  const [row] = await db
    .update(oauthAuthorizations)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthAuthorizations.codeHash, codeHash),
        isNull(oauthAuthorizations.consumedAt),
        gt(oauthAuthorizations.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!row) {
    await revokeTokensFromReusedCode(codeHash);
    throw new OAuthError("invalid_grant", "The authorization code is invalid, expired or used.");
  }
  if (row.clientId !== client.id) {
    throw new OAuthError("invalid_grant", "The code was issued to another client.");
  }
  if (redirectUri !== undefined && redirectUri !== row.redirectUri) {
    throw new OAuthError("invalid_grant", "redirect_uri doesn't match the authorization request.");
  }
  if (!PKCE_VERIFIER.test(verifier) || pkceChallenge(verifier) !== row.codeChallenge) {
    throw new OAuthError("invalid_grant", "PKCE verification failed.");
  }
  if (resource !== undefined && canonicalResource(resource) !== row.resource) {
    throw new OAuthError("invalid_target", "resource doesn't match the authorization request.");
  }
  const [agent] = row.agentId
    ? await db.select().from(agents).where(eq(agents.id, row.agentId))
    : [];
  if (!agent) throw new OAuthError("invalid_grant", "The agent no longer exists.");
  if (agent.frozenAt) throw new OAuthError("invalid_grant", "The agent is frozen by its owner.");

  const tokens = freshTokens();
  const tokenId = uuidv7();
  const recorded = await db.transaction(async (tx) => {
    await tx.insert(agentTokens).values({
      id: tokenId,
      agentId: agent.id,
      name: client.name,
      clientId: client.id,
      inboxCursor: currentLedgerSeq(agent.id),
      ...tokens.fields,
    });
    await tx.update(oauthAuthorizations).set({ tokenId }).where(eq(oauthAuthorizations.id, row.id));
    return appendLedgerEvent(tx, agent, {
      type: "token.created",
      actor: "owner",
      data: { tokenId, name: client.name, prefix: tokens.fields.prefix, via: "oauth" },
    });
  });
  await broadcast([recorded]);
  return tokenResponse(tokens.access, tokens.refresh);
}

// A code presented twice may have been intercepted, so the token it produced is revoked (RFC 6749 4.1.2).
async function revokeTokensFromReusedCode(codeHash: string): Promise<void> {
  const [used] = await db
    .select({ tokenId: oauthAuthorizations.tokenId })
    .from(oauthAuthorizations)
    .where(
      and(eq(oauthAuthorizations.codeHash, codeHash), isNotNull(oauthAuthorizations.consumedAt)),
    );
  if (used?.tokenId) await revokeLeakedToken(used.tokenId, "code_reused");
}

/** Revokes a token that showed signs of being copied, and tells the owner. */
async function revokeLeakedToken(
  tokenId: string,
  reason: Extract<RevokeReason, "code_reused" | "refresh_token_reused">,
): Promise<void> {
  const [row] = await db
    .select({ token: agentTokens, agent: agents })
    .from(agentTokens)
    .innerJoin(agents, eq(agents.id, agentTokens.agentId))
    .where(and(eq(agentTokens.id, tokenId), isNull(agentTokens.revokedAt)));
  if (!row) return;
  const revoked = await revokeTokens(row.agent, [tokenId], "system", reason);
  if (revoked === 0) return;
  logger.warn({ tokenId, reason }, "oauth credential reused, token revoked");
  await raiseAlert({
    agent: row.agent,
    kind: reason,
    tokenId,
    details: { client: row.token.name, tokenPrefix: row.token.prefix },
  });
}

async function refreshTokens(client: OAuthClient, params: Record<string, string | undefined>) {
  const presented = params.refresh_token;
  if (!presented) throw new OAuthError("invalid_request", "refresh_token is required.");
  if (params.resource !== undefined && !canonicalResource(params.resource)) {
    throw new OAuthError("invalid_target", `Tokens can only be issued for ${mcpResource}.`);
  }
  const hash = sha256(presented);
  const [row] = await db
    .select()
    .from(agentTokens)
    .where(
      and(
        eq(agentTokens.refreshTokenHash, hash),
        isNull(agentTokens.revokedAt),
        gt(agentTokens.refreshExpiresAt, new Date()),
      ),
    );
  if (!row) {
    // A rotated refresh token coming back means it leaked, so the whole grant goes.
    const [leaked] = await db
      .select({ id: agentTokens.id })
      .from(agentTokens)
      .where(and(eq(agentTokens.previousRefreshTokenHash, hash), isNull(agentTokens.revokedAt)));
    if (leaked) await revokeLeakedToken(leaked.id, "refresh_token_reused");
    throw new OAuthError("invalid_grant", "The refresh token is invalid, expired or revoked.");
  }
  if (row.clientId !== client.id) {
    throw new OAuthError("invalid_grant", "The refresh token was issued to another client.");
  }
  const [owning] = await db
    .select({ frozenAt: agents.frozenAt })
    .from(agents)
    .where(eq(agents.id, row.agentId));
  // Refused without revoking, so the connection works again once the owner unfreezes the agent.
  if (owning?.frozenAt) {
    throw new OAuthError("invalid_grant", "The agent is frozen by its owner.");
  }

  const tokens = freshTokens();
  const [rotated] = await db
    .update(agentTokens)
    .set({ ...tokens.fields, previousRefreshTokenHash: hash })
    .where(
      and(
        eq(agentTokens.id, row.id),
        eq(agentTokens.refreshTokenHash, hash),
        isNull(agentTokens.revokedAt),
      ),
    )
    .returning({ id: agentTokens.id });
  if (!rotated) throw new OAuthError("invalid_grant", "The refresh token was already used.");
  return tokenResponse(tokens.access, tokens.refresh);
}

export async function revokeToken(
  params: Record<string, string | undefined>,
  basic: ClientCredentials,
): Promise<void> {
  const client = await authenticateClient(params, basic);
  if (!params.token) throw new OAuthError("invalid_request", "token is required.");
  const hash = sha256(params.token);
  const [row] = await db
    .select({ token: agentTokens, agent: agents })
    .from(agentTokens)
    .innerJoin(agents, eq(agents.id, agentTokens.agentId))
    .where(
      and(
        or(eq(agentTokens.tokenHash, hash), eq(agentTokens.refreshTokenHash, hash)),
        eq(agentTokens.clientId, client.id),
        isNull(agentTokens.revokedAt),
      ),
    );
  if (row) await revokeAgentToken(row.agent, row.token.id, "agent");
}

export async function pruneOAuth(): Promise<void> {
  const now = new Date();
  await db.delete(oauthAuthorizations).where(lt(oauthAuthorizations.expiresAt, now));
  await db.delete(agentTokens).where(lt(agentTokens.refreshExpiresAt, now));
}
