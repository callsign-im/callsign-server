import {
  auth,
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { eq, sql } from "drizzle-orm";
import { config, usesHttps } from "../config.ts";
import { db } from "../db/client.ts";
import { mcpConnections, type McpConnection } from "../db/schema.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import type { DataKey } from "../lib/encryption.ts";
import { createSafeFetch } from "../lib/safe-http.ts";
import { VERSION } from "../version.ts";
import { AppError } from "./errors.ts";
import { connectionKey } from "./keys.ts";

const CONNECT_TIMEOUT_MS = 10_000;
// Refresh a little early, so a token doesn't expire between the check and the call.
const REFRESH_MARGIN_MS = 60_000;

export const toolFetch = createSafeFetch({
  allowPrivate: config.ALLOW_PRIVATE_TOOLS,
  idleTimeoutMs: 60_000,
});

export const CALLBACK_PATH = "/v1/connections/callback";
const callbackUrl = () => new URL(CALLBACK_PATH, config.PUBLIC_API_URL).toString();
export const clientMetadataUrl = () =>
  new URL("/oauth/client.json", config.PUBLIC_API_URL).toString();

/** How Callsign introduces itself to other servers' authorization servers. */
export function clientMetadata(): OAuthClientMetadata {
  return {
    ...(usesHttps && { client_id: clientMetadataUrl() }),
    client_name: "Callsign",
    client_uri: config.SITE_URL,
    redirect_uris: [callbackUrl()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

type StoredTokens = StoredOAuthTokens & { obtainedAt?: number };
export type HeaderSecret = { name: string; value: string };
type Credentials = { header?: HeaderSecret; tokens?: StoredTokens };

const context = (column: string, id: string) => `mcp_connections.${column}:${id}`;

async function reload(id: string): Promise<McpConnection> {
  const [row] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, id));
  if (!row) throw new AppError("not_found", "That connection no longer exists.");
  return row;
}

export function readCredentials(key: DataKey, connection: McpConnection): Credentials {
  const raw = key.open(connection.credentials, context("credentials", connection.id));
  return raw ? (JSON.parse(raw) as Credentials) : {};
}

export function sealCredentials(key: DataKey, id: string, credentials: Credentials) {
  return key.seal(JSON.stringify(credentials), context("credentials", id));
}

/**
 * The OAuth client for one connection, backed by its row. The SDK's auth() drives discovery,
 * registration (client ID metadata document over https, dynamic registration otherwise),
 * PKCE, issuer checks and refreshes through it.
 */
class ConnectionOAuth implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private stateValue: string | null = null;
  private readonly id: string;
  private readonly key: DataKey;

  constructor(id: string, key: DataKey) {
    this.id = id;
    this.key = key;
  }

  get redirectUrl() {
    return callbackUrl();
  }

  get clientMetadataUrl() {
    return usesHttps ? clientMetadataUrl() : undefined;
  }

  get clientMetadata() {
    return clientMetadata();
  }

  state() {
    this.stateValue ??= randomToken();
    return this.stateValue;
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    const row = await reload(this.id);
    const raw = this.key.open(row.oauthClient, context("oauth_client", this.id));
    return raw ? (JSON.parse(raw) as StoredOAuthClientInformation) : undefined;
  }

  async saveClientInformation(information: StoredOAuthClientInformation) {
    await db
      .update(mcpConnections)
      .set({
        oauthClient: this.key.seal(JSON.stringify(information), context("oauth_client", this.id)),
      })
      .where(eq(mcpConnections.id, this.id));
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return readCredentials(this.key, await reload(this.id)).tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens) {
    await db
      .update(mcpConnections)
      .set({
        credentials: sealCredentials(this.key, this.id, {
          tokens: { ...tokens, obtainedAt: Date.now() },
        }),
        credentialsVersion: sql`${mcpConnections.credentialsVersion} + 1`,
      })
      .where(eq(mcpConnections.id, this.id));
  }

  async redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
    await db
      .update(mcpConnections)
      .set({ pendingStateHash: sha256(this.state()) })
      .where(eq(mcpConnections.id, this.id));
  }

  async saveCodeVerifier(codeVerifier: string) {
    await db
      .update(mcpConnections)
      .set({
        oauthPending: this.key.seal(
          JSON.stringify({ codeVerifier }),
          context("oauth_pending", this.id),
        ),
      })
      .where(eq(mcpConnections.id, this.id));
  }

  async codeVerifier(): Promise<string> {
    const row = await reload(this.id);
    const raw = this.key.open(row.oauthPending, context("oauth_pending", this.id));
    if (!raw) throw new Error("no authorization is in progress for this connection");
    return (JSON.parse(raw) as { codeVerifier: string }).codeVerifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "discovery") return;
    await db
      .update(mcpConnections)
      .set({
        ...((scope === "all" || scope === "client") && { oauthClient: null }),
        ...((scope === "all" || scope === "tokens") && { credentials: null }),
        ...((scope === "all" || scope === "verifier") && { oauthPending: null }),
      })
      .where(eq(mcpConnections.id, this.id));
  }
}

/** Starts signing in to the server. Returns where to send the owner, or null if already in. */
export async function startConnectionAuth(connection: McpConnection): Promise<URL | null> {
  const provider = new ConnectionOAuth(connection.id, await connectionKey(connection));
  try {
    const result = await auth(provider, { serverUrl: connection.serverUrl, fetchFn: toolFetch });
    return result === "REDIRECT" ? provider.authorizationUrl : null;
  } catch (error) {
    throw new AppError(
      "invalid_input",
      `Couldn't start signing in to ${new URL(connection.serverUrl).host}: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
  }
}

/** Finishes signing in when the owner comes back from the server's authorization page. */
export async function finishConnectionAuth(input: {
  state: string;
  code: string;
  iss?: string | undefined;
}): Promise<McpConnection> {
  const [connection] = await db
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.pendingStateHash, sha256(input.state)));
  if (!connection) throw new AppError("not_found", "This sign-in link expired. Connect again.");
  const provider = new ConnectionOAuth(connection.id, await connectionKey(connection));
  const result = await auth(provider, {
    serverUrl: connection.serverUrl,
    authorizationCode: input.code,
    ...(input.iss && { iss: input.iss }),
    fetchFn: toolFetch,
  });
  if (result !== "AUTHORIZED")
    throw new AppError("conflict", "The server didn't finish signing in.");
  const [done] = await db
    .update(mcpConnections)
    .set({ pendingStateHash: null, oauthPending: null, status: "active", lastError: null })
    .where(eq(mcpConnections.id, connection.id))
    .returning();
  return done ?? connection;
}

function stale(tokens: StoredTokens | undefined): boolean {
  if (!tokens?.expires_in || !tokens.obtainedAt) return false;
  return tokens.obtainedAt + tokens.expires_in * 1000 - REFRESH_MARGIN_MS < Date.now();
}

export class NeedsReauthError extends AppError {
  constructor(host: string) {
    super("conflict", `The connection to ${host} needs its owner to sign in again.`);
  }
}

// One refresh at a time per connection: two concurrent refreshes would present the same refresh
// token twice, and servers that detect reuse revoke the whole grant.
async function refreshIfStale(connection: McpConnection, key: DataKey): Promise<void> {
  if (!stale(readCredentials(key, connection).tokens)) return;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`mcp-refresh:${connection.id}`}))`,
    );
    const fresh = await reload(connection.id);
    if (!stale(readCredentials(key, fresh).tokens)) return;
    const provider = new ConnectionOAuth(connection.id, key);
    const result = await auth(provider, { serverUrl: connection.serverUrl, fetchFn: toolFetch });
    if (result !== "AUTHORIZED") throw new NeedsReauthError(new URL(connection.serverUrl).host);
  });
}

export function isReauthError(error: unknown): boolean {
  return error instanceof NeedsReauthError || UnauthorizedError.isInstance(error);
}

/** Opens a short-lived MCP client to the connection's server, runs `use`, and closes it. */
export async function withUpstream<T>(
  connection: McpConnection,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const key = await connectionKey(connection);
  const credentials = readCredentials(key, connection);
  if (connection.authKind === "oauth") await refreshIfStale(connection, key);
  const client = new Client({ name: "Callsign", version: VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(connection.serverUrl), {
    fetch: toolFetch,
    ...(connection.authKind === "header" &&
      credentials.header && {
        requestInit: { headers: { [credentials.header.name]: credentials.header.value } },
      }),
    ...(connection.authKind === "oauth" && {
      authProvider: new ConnectionOAuth(connection.id, key),
    }),
  });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return await use(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}
