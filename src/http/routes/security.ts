import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { Hono } from "hono";
import { z } from "zod";
import { getOwnedAgent, revokeTokens } from "../../domain/agents.ts";
import {
  acknowledgeAlert,
  actOnAlertLink,
  alertLinkView,
  freezeFromAlert,
  listAlerts,
} from "../../domain/alerts.ts";
import { freezeAgent, unfreezeAgent } from "../../domain/freeze.ts";
import {
  decideHold,
  decideHoldByLink,
  decideHolds,
  holdLinkView,
  listHolds,
  pendingHoldCount,
} from "../../domain/holds.ts";
import {
  cancelPasskeyReset,
  cancelPasskeyResetByLink,
  isElevated,
  listPasskeys,
  passkeyResetByLink,
  pendingPasskeyReset,
  registerPasskey,
  registrationOptions,
  removePasskey,
  renamePasskey,
  requestPasskeyReset,
  stepUpOptions,
  verifyStepUp,
} from "../../domain/passkeys.ts";
import { policyPatch, readPolicy, updatePolicy } from "../../domain/policy.ts";
import { listAgentNetworks, listTokenSightings } from "../../domain/sightings.ts";
import { requireAppOrigin, requireOwner, requireStepUp } from "../auth.ts";
import { parseBody, parseWith, type AppEnv } from "../context.ts";
import { detailView } from "./owner.ts";

const linkToken = z.string().min(1).max(100);
const passkeyName = z.string().trim().min(1).max(60);

// The browser's WebAuthn JSON; @simplewebauthn checks every field that matters.
const credentialJson = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal("public-key"),
  response: z.looseObject({}),
});

const decision = z.enum(["approve", "deny"]);

export const securityRoutes = new Hono<AppEnv>()
  .use("/v1/me/*", requireOwner)
  .use("/v1/agents/*", requireOwner)
  .use("/v1/alerts", requireOwner)
  .use("/v1/alerts/*", requireOwner)
  .use("/v1/holds", requireOwner)
  .use("/v1/holds/*", requireOwner)
  .get("/v1/agents/:handle/policy", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    return c.json({ policy: readPolicy(agent) });
  })
  .patch("/v1/agents/:handle/policy", async (c) => {
    const owner = c.get("owner");
    const agent = await getOwnedAgent(owner.id, c.req.param("handle"));
    const patch = await parseBody(c, policyPatch);
    const { policy } = await updatePolicy(owner, c.get("session"), agent, patch);
    return c.json({ policy });
  })
  .get("/v1/holds", async (c) => {
    const owner = c.get("owner");
    const { status, agent: handle } = parseWith(
      z.object({
        status: z.enum(["pending", "all"]).default("pending"),
        agent: z.string().max(64).optional(),
      }),
      c.req.query(),
    );
    const agent = handle ? await getOwnedAgent(owner.id, handle) : undefined;
    const [holds, pending] = await Promise.all([
      listHolds(owner, { status, ...(agent && { agent }) }),
      pendingHoldCount(owner.id),
    ]);
    return c.json({ holds, pending });
  })
  .post("/v1/holds/decide", async (c) => {
    const body = await parseBody(c, z.object({ ids: z.array(z.uuid()).min(1).max(100), decision }));
    return c.json(await decideHolds(c.get("owner"), c.get("session"), body.ids, body.decision));
  })
  .post("/v1/holds/:id", async (c) => {
    const { decision: choice } = await parseBody(c, z.object({ decision }));
    const id = parseWith(z.uuid(), c.req.param("id"));
    return c.json({ hold: await decideHold(c.get("owner"), c.get("session"), id, choice) });
  })
  .get("/v1/hold-links/:token", async (c) =>
    c.json({ hold: await holdLinkView(parseWith(linkToken, c.req.param("token"))) }),
  )
  .post("/v1/hold-links/:token", async (c) => {
    const { decision: choice } = await parseBody(c, z.object({ decision }));
    const token = parseWith(linkToken, c.req.param("token"));
    return c.json({ hold: await decideHoldByLink(token, choice) });
  })
  .get("/v1/me/passkeys", async (c) => {
    const owner = c.get("owner");
    const session = c.get("session");
    const [passkeys, reset] = await Promise.all([
      listPasskeys(owner.id),
      pendingPasskeyReset(owner.id),
    ]);
    return c.json({
      passkeys,
      reset,
      elevatedUntil: isElevated(session) ? session.elevatedUntil?.toISOString() : null,
    });
  })
  .post("/v1/me/passkeys/options", requireAppOrigin, async (c) =>
    c.json({ options: await registrationOptions(c.get("owner"), c.get("session")) }),
  )
  .post("/v1/me/passkeys", requireAppOrigin, async (c) => {
    const { response, name } = await parseBody(
      c,
      z.object({ response: credentialJson, name: passkeyName.optional() }),
    );
    const passkey = await registerPasskey(
      c.get("owner"),
      c.get("session"),
      response as unknown as RegistrationResponseJSON,
      name,
    );
    return c.json({ passkey }, 201);
  })
  .post("/v1/me/passkeys/reset", requireAppOrigin, async (c) =>
    c.json({ reset: await requestPasskeyReset(c.get("owner"), c.get("session")) }, 201),
  )
  .post("/v1/me/passkeys/reset/cancel", async (c) => {
    await cancelPasskeyReset(c.get("owner"));
    return c.body(null, 204);
  })
  .patch("/v1/me/passkeys/:id", async (c) => {
    const { name } = await parseBody(c, z.object({ name: passkeyName }));
    await renamePasskey(c.get("owner").id, parseWith(z.uuid(), c.req.param("id")), name);
    return c.body(null, 204);
  })
  .delete("/v1/me/passkeys/:id", async (c) => {
    await removePasskey(c.get("owner"), c.get("session"), parseWith(z.uuid(), c.req.param("id")));
    return c.body(null, 204);
  })
  .post("/v1/me/step-up/options", requireAppOrigin, async (c) =>
    c.json({ options: await stepUpOptions(c.get("owner"), c.get("session")) }),
  )
  .post("/v1/me/step-up", requireAppOrigin, async (c) => {
    const { response } = await parseBody(c, z.object({ response: credentialJson }));
    return c.json(
      await verifyStepUp(
        c.get("owner"),
        c.get("session"),
        response as unknown as AuthenticationResponseJSON,
      ),
    );
  })
  .post("/v1/agents/:handle/freeze", async (c) => {
    const owner = c.get("owner");
    const { alertId } = await parseBody(c, z.object({ alertId: z.uuid().optional() }));
    const agent = await getOwnedAgent(owner.id, c.req.param("handle"));
    const frozen = alertId
      ? await freezeFromAlert(owner, alertId, "dashboard", agent.id)
      : await freezeAgent(agent, { actor: "owner", via: "dashboard" });
    return c.json({ agent: await detailView(frozen) });
  })
  .post("/v1/agents/:handle/unfreeze", async (c) => {
    const owner = c.get("owner");
    const { revokeTokens: revoke } = await parseBody(
      c,
      z.object({ revokeTokens: z.boolean().default(false) }),
    );
    const agent = await getOwnedAgent(owner.id, c.req.param("handle"));
    const thawed = await unfreezeAgent(owner, c.get("session"), agent, { revokeTokens: revoke });
    return c.json({ agent: await detailView(thawed.agent), revokedTokens: thawed.revokedTokens });
  })
  .post("/v1/agents/:handle/tokens/revoke-all", requireStepUp, async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    return c.json({ revoked: await revokeTokens(agent, "all", "owner", "revoke_all") });
  })
  .get("/v1/agents/:handle/tokens/:tokenId/sightings", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    const tokenId = parseWith(z.uuid(), c.req.param("tokenId"));
    return c.json({ sightings: await listTokenSightings(agent, tokenId) });
  })
  .get("/v1/agents/:handle/networks", async (c) => {
    const agent = await getOwnedAgent(c.get("owner").id, c.req.param("handle"));
    return c.json({ networks: await listAgentNetworks(agent) });
  })
  .get("/v1/alerts", async (c) => {
    const { status } = parseWith(
      z.object({ status: z.enum(["open", "all"]).default("open") }),
      c.req.query(),
    );
    return c.json({ alerts: await listAlerts(c.get("owner"), { open: status === "open" }) });
  })
  .post("/v1/alerts/:id/ack", async (c) => {
    await acknowledgeAlert(c.get("owner"), parseWith(z.uuid(), c.req.param("id")), "dashboard");
    return c.body(null, 204);
  })
  .get("/v1/freeze-links/:token", async (c) =>
    c.json({ alert: await alertLinkView(parseWith(linkToken, c.req.param("token"))) }),
  )
  .post("/v1/freeze-links/:token", async (c) => {
    const { action } = await parseBody(c, z.object({ action: z.enum(["freeze", "acknowledge"]) }));
    const token = parseWith(linkToken, c.req.param("token"));
    return c.json({ alert: await actOnAlertLink(token, action) });
  })
  .get("/v1/passkey-resets/:token", async (c) =>
    c.json({ reset: await passkeyResetByLink(parseWith(linkToken, c.req.param("token"))) }),
  )
  .post("/v1/passkey-resets/:token/cancel", async (c) =>
    c.json(await cancelPasskeyResetByLink(parseWith(linkToken, c.req.param("token")))),
  );
