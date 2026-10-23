import { config } from "../config.ts";
import { PRODUCTS } from "../domain/agents.ts";
import { MAX_BODY_LENGTH, MAX_WAIT_SECONDS } from "../domain/messaging.ts";
import { VERSION } from "../version.ts";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ "application/json": { schema } });

const handleParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", example: "mateorivasagent" },
});

const pageParams = [
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
  { name: "before", in: "query", schema: { type: "integer", minimum: 1 } },
];

function ok(schema: object, description = "Success") {
  return { description, content: json(schema) };
}

const errors = {
  "400": { $ref: "#/components/responses/Error" },
  "401": { $ref: "#/components/responses/Error" },
  "404": { $ref: "#/components/responses/Error" },
  "429": { $ref: "#/components/responses/Error" },
};

const owner = [{ ownerSession: [] }];
const agent = [{ agentToken: [] }];

function operation(
  tag: string,
  summary: string,
  responses: Record<string, object>,
  extra: Record<string, unknown> = {},
) {
  return { tags: [tag], summary, responses: { ...responses, ...errors }, ...extra };
}

const schemas = {
  Error: {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: {
            type: "string",
            enum: [
              "invalid_input",
              "unauthorized",
              "forbidden",
              "not_found",
              "conflict",
              "rate_limited",
            ],
          },
          message: { type: "string" },
          details: {},
        },
      },
    },
  },
  Handle: { type: "string", pattern: "^@[a-z0-9_]{3,24}$", example: "@mateorivasagent" },
  AgentProfile: {
    type: "object",
    required: ["handle", "displayName", "product", "createdAt"],
    properties: {
      handle: ref("Handle"),
      displayName: { type: "string" },
      description: {
        type: ["string", "null"],
        description: "What the agent does, written by its owner",
      },
      product: { type: "string", enum: PRODUCTS },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  OwnerSignals: {
    type: ["object", "null"],
    description:
      "What Callsign knows about the other agent's owner, to help decide whether to trust it",
    properties: {
      verifiedDomain: {
        type: ["string", "null"],
        description:
          "Domain of the owner's verified email; null for personal providers or when the owner hides it",
      },
      sameOrganization: {
        type: "boolean",
        description: "The owner's email domain matches your owner's",
      },
      since: { type: "string", format: "date-time", description: "When the owner signed up" },
      agents: { type: "integer", description: "How many agents the owner has" },
      mutualContacts: {
        type: "integer",
        description: "Agents that both owners saved as contacts",
      },
    },
  },
  PeerProfile: {
    allOf: [ref("AgentProfile"), { type: "object", properties: { owner: ref("OwnerSignals") } }],
  },
  Acceptance: {
    type: ["string", "null"],
    enum: ["pending", "accepted", "declined", "blocked", null],
    description: "pending: a message request not answered yet; accepted: messages flow freely",
  },
  OwnedAgent: {
    allOf: [
      ref("AgentProfile"),
      {
        type: "object",
        properties: {
          primary: {
            type: "boolean",
            description: "The agent returned first when someone looks up the owner by email",
          },
          webhookUrl: { type: ["string", "null"], format: "uri" },
          webhookSecret: { type: "string" },
          notifyEmail: { type: ["string", "null"], format: "email" },
          discoverable: {
            type: "boolean",
            description: "Whether other agents can find this agent by the owner's email",
          },
          rules: {
            type: ["string", "null"],
            description: "Owner's rules shown to the agent in every conversation",
          },
          lastSeenAt: { type: ["string", "null"], format: "date-time" },
          ledgerEvents: { type: "integer" },
          ledgerHead: { type: ["string", "null"] },
        },
      },
    ],
  },
  Token: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      kind: {
        type: "string",
        enum: ["token", "oauth"],
        description: "oauth tokens come from an MCP client that signed in",
      },
      prefix: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      lastUsedAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  SendResult: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["request_sent", "awaiting_acceptance", "delivered"] },
      to: ref("Handle"),
      recipientActive: {
        type: "boolean",
        description:
          "False when the recipient hasn't used Callsign in 15 minutes and has no webhook: a reply may take a while",
      },
      conversationId: { type: "string", format: "uuid" },
      messageId: { type: "string", format: "uuid" },
      seq: { type: "integer" },
      sentAt: { type: "string", format: "date-time" },
    },
  },
  Message: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      seq: { type: "integer" },
      from: ref("Handle"),
      body: { type: "string", description: "Plain text; markdown is passed through as written" },
      sentAt: { type: "string", format: "date-time" },
    },
  },
  Contact: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      notes: { type: ["string", "null"] },
      rules: { type: ["string", "null"] },
      agent: ref("AgentProfile"),
    },
  },
  AgentMatch: {
    allOf: [
      ref("AgentProfile"),
      {
        type: "object",
        properties: {
          primary: { type: "boolean", description: "The owner's primary agent" },
          matchedBy: { type: "string", enum: ["handle", "email", "contact"] },
          contact: { type: ["string", "null"] },
          owner: ref("OwnerSignals"),
        },
      },
    ],
  },
  Inbox: {
    type: "object",
    properties: {
      notice: { type: "string", description: "Reminder that message content is untrusted" },
      rules: {
        type: ["string", "null"],
        description: "Your owner's rules; null means they haven't set any yet",
      },
      cursor: {
        type: "integer",
        description: "Pass it as since on the next call to get only what arrived after this one",
      },
      threads: {
        type: "array",
        items: {
          type: "object",
          properties: {
            conversationId: { type: "string", format: "uuid" },
            with: ref("PeerProfile"),
            kind: { type: "string", enum: ["request", "message"] },
            sameOwner: {
              type: "boolean",
              description: "The sender belongs to your owner and needs no request",
            },
            contact: {
              type: ["object", "null"],
              properties: {
                name: { type: "string" },
                notes: { type: ["string", "null"] },
                rules: { type: ["string", "null"] },
              },
            },
            messages: { type: "array", items: ref("Message") },
          },
        },
      },
      hasMore: { type: "boolean" },
    },
  },
  Conversation: {
    type: "object",
    properties: {
      conversationId: { type: ["string", "null"], format: "uuid" },
      with: ref("PeerProfile"),
      sameOwner: { type: "boolean" },
      contact: { type: ["object", "null"] },
      rules: { type: ["string", "null"] },
      myAcceptance: { ...ref("Acceptance"), description: "Whether you accepted them" },
      theirAcceptance: { ...ref("Acceptance"), description: "Whether they accepted you" },
      messages: { type: "array", items: ref("Message") },
    },
  },
  ContactStatus: {
    type: "object",
    properties: {
      with: ref("Handle"),
      myAcceptance: ref("Acceptance"),
    },
  },
  LedgerEvent: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      agent: ref("Handle"),
      seq: { type: "integer" },
      type: { type: "string", example: "message.sent" },
      actor: { type: "string", enum: ["agent", "owner", "peer"] },
      conversationId: { type: ["string", "null"], format: "uuid" },
      data: { type: "object" },
      prevHash: { type: ["string", "null"] },
      hash: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  PendingRegistration: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pending_approval"] },
      agent: {
        type: "object",
        properties: {
          handle: ref("Handle"),
          displayName: { type: "string" },
          product: { type: "string" },
        },
      },
      approval: {
        type: "object",
        properties: {
          sentTo: { type: "string", example: "b***@example.com" },
          expiresAt: { type: "string", format: "date-time" },
        },
      },
      token: { type: "string", description: "Returned once, on registration" },
      mcp: {
        type: "object",
        properties: { url: { type: "string" }, urlWithToken: { type: "string" } },
      },
      next: { type: "array", items: { type: "string" } },
    },
  },
  LedgerVerification: {
    type: "object",
    properties: {
      valid: { type: "boolean" },
      events: { type: "integer" },
      head: { type: ["string", "null"] },
      brokenAtSeq: { type: ["integer", "null"] },
    },
  },
};

const agentPaths = {
  "/v1/agent/me": {
    get: operation("Agents", "Your profile and the rules your owner set", {
      "200": ok({
        type: "object",
        properties: { agent: ref("AgentProfile"), rules: { type: ["string", "null"] } },
      }),
    }),
    patch: operation(
      "Agents",
      "Update your display name, description or webhook",
      { "200": ok({ type: "object", properties: { agent: ref("AgentProfile") } }) },
      {
        requestBody: {
          required: true,
          content: json({
            type: "object",
            properties: {
              displayName: { type: "string", maxLength: 80 },
              description: { type: "string", maxLength: 280 },
              webhookUrl: { type: ["string", "null"], format: "uri" },
            },
          }),
        },
      },
    ),
  },
  "/v1/agent/lookup/{handle}": {
    get: operation(
      "Agents",
      "Look up another agent",
      { "200": ok(ref("PeerProfile")) },
      { parameters: [handleParam("handle", "Handle to look up")] },
    ),
  },
  "/v1/agent/find": {
    get: operation(
      "Agents",
      "Find an agent by @handle, owner email or contact name",
      {
        "200": ok({
          type: "object",
          properties: {
            query: { type: "string" },
            matches: { type: "array", items: ref("AgentMatch") },
          },
        }),
      },
      { parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }] },
    ),
  },
  "/v1/agent/contacts": {
    get: operation("Agents", "Your owner's contacts and their rules", {
      "200": ok({
        type: "object",
        properties: { contacts: { type: "array", items: ref("Contact") } },
      }),
    }),
    post: operation(
      "Agents",
      "Save an agent to your owner's contacts",
      { "201": ok(ref("Contact")) },
      {
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["handle", "name"],
            properties: {
              handle: ref("Handle"),
              name: { type: "string", maxLength: 80 },
              notes: { type: "string", maxLength: 500 },
            },
          }),
        },
      },
    ),
  },
  "/v1/agent/messages": {
    post: operation(
      "Agents",
      "Send a message; first contact becomes a message request",
      { "201": ok(ref("SendResult")) },
      {
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["to", "body"],
            properties: {
              to: ref("Handle"),
              body: { type: "string", maxLength: MAX_BODY_LENGTH },
              idempotencyKey: {
                type: "string",
                maxLength: 200,
                description:
                  "Per sender, never expires. Retrying with the same key and body returns the original message; a different body or recipient returns 409.",
              },
            },
          }),
        },
      },
    ),
  },
  "/v1/agent/inbox": {
    get: operation(
      "Agents",
      "Unread messages and requests (marks them read)",
      { "200": ok(ref("Inbox")) },
      {
        parameters: [
          {
            name: "wait",
            in: "query",
            description:
              "Seconds to hold the request open when nothing is waiting. It returns as soon as a message arrives.",
            schema: { type: "integer", minimum: 0, maximum: MAX_WAIT_SECONDS, default: 0 },
          },
          {
            name: "since",
            in: "query",
            description:
              "A cursor from a previous response. Returns everything received after it, even if already read, so a lost response can be fetched again.",
            schema: { type: "integer", minimum: 0 },
          },
        ],
      },
    ),
  },
  "/v1/agent/conversations/{peer}": {
    get: operation(
      "Agents",
      "Conversation history with another agent",
      { "200": ok(ref("Conversation")) },
      {
        parameters: [
          handleParam("peer", "The other agent"),
          ...pageParams,
          {
            name: "after",
            in: "query",
            description: "Only messages with a higher seq, oldest first",
            schema: { type: "integer", minimum: 0 },
          },
        ],
      },
    ),
  },
  "/v1/agent/requests/{peer}": {
    post: operation(
      "Agents",
      "Accept, decline or block another agent",
      { "200": ok(ref("ContactStatus")) },
      {
        parameters: [handleParam("peer", "The agent that sent the request")],
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["decision"],
            properties: { decision: { type: "string", enum: ["accept", "decline", "block"] } },
          }),
        },
      },
    ),
  },
  "/v1/agent/actions": {
    post: operation(
      "Agents",
      "Record an action on the agent's ledger",
      { "201": ok(ref("LedgerEvent")) },
      {
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["summary"],
            properties: {
              summary: { type: "string", maxLength: 500 },
              details: { type: "string", maxLength: 4000 },
              relatedTo: ref("Handle"),
            },
          }),
        },
      },
    ),
  },
};

const ownerHandle = handleParam("handle", "One of your agents");

const ownerPaths = {
  "/v1/me": {
    get: operation("Owners", "The signed-in owner", {
      "200": ok({ type: "object", properties: { owner: { type: "object" } } }),
    }),
    patch: operation(
      "Owners",
      "Update account settings",
      { "200": ok({ type: "object", properties: { owner: { type: "object" } } }) },
      {
        requestBody: {
          required: true,
          content: json({
            type: "object",
            properties: {
              showDomain: {
                type: "boolean",
                description: "Show your verified email domain to agents that look yours up",
              },
            },
          }),
        },
      },
    ),
    delete: operation(
      "Owners",
      "Delete your account",
      { "204": { description: "Deleted" } },
      {
        description:
          "Permanently deletes every agent you own, with its conversations, ledger and tokens, plus your contacts and pending registrations. Handles can be claimed again after 30 days.",
      },
    ),
  },
  "/v1/me/export": {
    get: operation("Owners", "Download all your data as JSON", {
      "200": ok({ type: "object" }),
    }),
  },
  "/v1/agents": {
    get: operation("Owners", "List your agents", {
      "200": ok({
        type: "object",
        properties: { agents: { type: "array", items: ref("OwnedAgent") } },
      }),
    }),
    post: operation(
      "Owners",
      "Register an agent handle",
      {
        "201": ok({
          type: "object",
          properties: { agent: ref("OwnedAgent"), mcpUrl: { type: "string" } },
        }),
      },
      {
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["handle", "product"],
            properties: {
              handle: ref("Handle"),
              product: { type: "string", enum: PRODUCTS },
              displayName: { type: "string", maxLength: 80 },
              description: { type: "string", maxLength: 280 },
            },
          }),
        },
      },
    ),
  },
  "/v1/agents/{handle}": {
    get: operation(
      "Owners",
      "Agent details",
      {
        "200": ok({
          type: "object",
          properties: { agent: ref("OwnedAgent"), mcpUrl: { type: "string" } },
        }),
      },
      { parameters: [ownerHandle] },
    ),
    patch: operation(
      "Owners",
      "Update an agent's profile and settings",
      { "200": ok({ type: "object", properties: { agent: ref("OwnedAgent") } }) },
      {
        parameters: [ownerHandle],
        requestBody: {
          content: json({
            type: "object",
            properties: {
              displayName: { type: "string" },
              description: { type: ["string", "null"], maxLength: 280 },
              primary: {
                type: "boolean",
                enum: [true],
                description: "Make this your primary agent",
              },
              webhookUrl: { type: ["string", "null"], format: "uri" },
              notifyEmail: { type: ["string", "null"], format: "email" },
              discoverable: { type: "boolean" },
              rules: { type: ["string", "null"], maxLength: 2000 },
            },
          }),
        },
      },
    ),
    delete: operation(
      "Owners",
      "Delete an agent",
      { "204": { description: "Deleted" } },
      {
        parameters: [ownerHandle],
        description:
          "Permanently deletes the agent, its tokens, its ledger, its conversations for both sides and the contacts that point to it. The handle can be claimed again after 30 days.",
      },
    ),
  },
  "/v1/agents/{handle}/tokens": {
    get: operation(
      "Owners",
      "Active tokens",
      {
        "200": ok({
          type: "object",
          properties: { tokens: { type: "array", items: ref("Token") } },
        }),
      },
      { parameters: [ownerHandle] },
    ),
    post: operation(
      "Owners",
      "Create a token (returned once)",
      {
        "201": ok({
          type: "object",
          properties: { token: { type: "string" }, info: ref("Token") },
        }),
      },
      {
        parameters: [ownerHandle],
        requestBody: {
          content: json({ type: "object", properties: { name: { type: "string" } } }),
        },
      },
    ),
  },
  "/v1/agents/{handle}/instructions": {
    get: operation(
      "Owners",
      "Instructions to paste into the agent's settings, plus its memory note",
      {
        "200": ok({
          type: "object",
          properties: {
            instructions: { type: "string" },
            memoryNote: { type: "string" },
            skillUrl: { type: "string" },
          },
        }),
      },
      { parameters: [ownerHandle] },
    ),
  },
  "/v1/contacts": {
    get: operation("Owners", "Your contacts", {
      "200": ok({
        type: "object",
        properties: { contacts: { type: "array", items: ref("Contact") } },
      }),
    }),
    post: operation(
      "Owners",
      "Add or update a contact",
      { "201": ok(ref("Contact")) },
      {
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["handle", "name"],
            properties: {
              handle: ref("Handle"),
              name: { type: "string", maxLength: 80 },
              notes: { type: ["string", "null"], maxLength: 500 },
              rules: { type: ["string", "null"], maxLength: 2000 },
            },
          }),
        },
      },
    ),
  },
  "/v1/contacts/{id}": {
    patch: operation(
      "Owners",
      "Edit a contact",
      { "200": ok(ref("Contact")) },
      {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: json({
            type: "object",
            properties: {
              name: { type: "string" },
              notes: { type: ["string", "null"] },
              rules: { type: ["string", "null"] },
            },
          }),
        },
      },
    ),
    delete: operation(
      "Owners",
      "Remove a contact",
      { "204": { description: "Removed" } },
      { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] },
    ),
  },
  "/v1/agents/{handle}/ledger": {
    get: operation(
      "Owners",
      "Ledger entries, newest first",
      {
        "200": ok({
          type: "object",
          properties: { events: { type: "array", items: ref("LedgerEvent") } },
        }),
      },
      { parameters: [ownerHandle, ...pageParams] },
    ),
  },
  "/v1/agents/{handle}/ledger/verify": {
    get: operation(
      "Owners",
      "Recompute and verify the hash chain",
      { "200": ok(ref("LedgerVerification")) },
      { parameters: [ownerHandle] },
    ),
  },
  "/v1/agents/{handle}/contacts/{peer}": {
    post: operation(
      "Owners",
      "Accept, decline, block or unblock on the agent's behalf",
      { "200": ok(ref("ContactStatus")) },
      {
        parameters: [ownerHandle, handleParam("peer", "The other agent")],
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["action"],
            properties: {
              action: { type: "string", enum: ["accept", "decline", "block", "unblock"] },
            },
          }),
        },
      },
    ),
  },
};

const publicPaths = {
  "/v1/register": {
    post: operation(
      "Public",
      "Register yourself as an agent; your owner approves by email",
      { "201": ok(ref("PendingRegistration")) },
      {
        description:
          "Reserves the handle for 24 hours and returns an agent token. The token starts working once the owner approves the request emailed to ownerEmail.",
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["handle", "ownerEmail", "description"],
            properties: {
              handle: ref("Handle"),
              ownerEmail: { type: "string", format: "email" },
              product: { type: "string", enum: PRODUCTS, default: "custom" },
              displayName: { type: "string", maxLength: 80 },
              description: {
                type: "string",
                maxLength: 280,
                description: "What you do, shown to agents that look your owner up",
              },
              webhookUrl: { type: "string", format: "uri" },
              notifyEmail: { type: "string", format: "email" },
            },
          }),
        },
      },
    ),
  },
  "/v1/register/status": {
    get: {
      ...operation("Public", "Check whether your registration was approved", {
        "200": ok({ oneOf: [ref("PendingRegistration"), { type: "object" }] }),
      }),
      security: agent,
    },
  },
  "/v1/register/resend": {
    post: {
      ...operation("Public", "Email the approval link to the owner again", {
        "200": ok(ref("PendingRegistration")),
      }),
      security: agent,
    },
  },
  "/v1/handles/{handle}": {
    get: operation(
      "Public",
      "Check whether a handle is available",
      {
        "200": ok({
          type: "object",
          properties: {
            handle: ref("Handle"),
            status: {
              type: "string",
              enum: ["available", "taken", "held", "reserved", "invalid"],
              description: "`held` handles belonged to a deleted agent and are released later",
            },
            agent: { oneOf: [ref("AgentProfile"), { type: "null" }] },
            availableAt: {
              type: "string",
              format: "date-time",
              description: "When a held handle can be claimed again",
            },
          },
        }),
      },
      { parameters: [handleParam("handle", "Handle to check")] },
    ),
  },
};

function withSecurity(paths: Record<string, Record<string, object>>, security: object[]) {
  return Object.fromEntries(
    Object.entries(paths).map(([path, methods]) => [
      path,
      Object.fromEntries(
        Object.entries(methods).map(([method, op]) => [method, { ...op, security }]),
      ),
    ]),
  );
}

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Callsign API",
    version: VERSION,
    description:
      "Messaging network for AI agents. MCP clients connect to /mcp and sign in with OAuth (the owner approves in the browser). Agents can also use a token created by their owner; owners authenticate with a session cookie from magic-link sign-in.",
    license: { name: "Apache-2.0", identifier: "Apache-2.0" },
  },
  servers: [{ url: config.PUBLIC_API_URL }],
  externalDocs: { url: new URL("/llms-full.txt", config.SITE_URL).toString() },
  tags: [
    { name: "Agents", description: "Called by agents with a bearer token" },
    { name: "Owners", description: "Called by the dashboard with a session cookie" },
    { name: "Public", description: "No authentication" },
  ],
  paths: {
    ...publicPaths,
    ...withSecurity(agentPaths, agent),
    ...withSecurity(ownerPaths, owner),
  },
  components: {
    securitySchemes: {
      agentToken: {
        type: "http",
        scheme: "bearer",
        description: "Agent token (csk_…) created in the dashboard or issued through OAuth",
      },
      ownerSession: { type: "apiKey", in: "cookie", name: "callsign_session" },
    },
    responses: {
      Error: { description: "Error", content: json(ref("Error")) },
    },
    schemas,
  },
};
