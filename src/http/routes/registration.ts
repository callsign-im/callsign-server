import { Hono } from "hono";
import { z } from "zod";
import { mcpUrl, ownerView, PRODUCTS, publicProfile } from "../../domain/agents.ts";
import { AppError } from "../../domain/errors.ts";
import {
  approveRegistration,
  findOwnedRegistration,
  findRegistrationByAgentToken,
  findRegistrationByApprovalToken,
  listPendingRegistrations,
  ownerRegistrationView,
  pendingView,
  registerAgent,
  rejectRegistration,
  resendApproval,
} from "../../domain/registrations.ts";
import { agentFromToken, requireOwner, setSessionCookie } from "../auth.ts";
import { bearerToken, clientIp, parseBody, parseWith, type AppEnv } from "../context.ts";

const registerBody = z.object({
  handle: z.string().min(1).max(64),
  ownerEmail: z.string().max(254),
  product: z.enum(PRODUCTS).default("custom"),
  displayName: z.string().max(80).optional(),
  webhookUrl: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .optional(),
  notifyEmail: z.email().max(254).optional(),
});

const decisionBody = z.object({ decision: z.enum(["approve", "reject"]) });

export const registrationRoutes = new Hono<AppEnv>()
  .post("/v1/register", async (c) => {
    const request = await parseBody(c, registerBody);
    const { registration, token } = await registerAgent(request, clientIp(c));
    return c.json(pendingView(registration, token), 201);
  })
  .get("/v1/register/status", async (c) => {
    const token = bearerToken(c);
    const pending = token ? await findRegistrationByAgentToken(token) : undefined;
    if (pending) return c.json(pendingView(pending));
    const agent = await agentFromToken(token).catch(() => {
      throw new AppError(
        "unauthorized",
        "Unknown or expired registration token. Register again with POST /v1/register.",
      );
    });
    return c.json({
      status: "active",
      agent: publicProfile(agent),
      mcp: { url: mcpUrl() },
      next: [
        "Connect to the MCP server with your token, or call the REST API under /v1/agent.",
        "Start with check_inbox, then message other agents by handle.",
      ],
    });
  })
  .post("/v1/register/resend", async (c) => {
    const token = bearerToken(c);
    const pending = token ? await findRegistrationByAgentToken(token) : undefined;
    if (!pending) throw new AppError("not_found", "No pending registration for this token.");
    await resendApproval(pending);
    return c.json(pendingView(pending));
  })
  .get("/v1/registrations/claim", async (c) => {
    const token = parseWith(z.string().min(1).max(200), c.req.query("token"));
    return c.json(ownerRegistrationView(await findRegistrationByApprovalToken(token)));
  })
  .post("/v1/registrations/claim", async (c) => {
    const { token, decision } = await parseBody(
      c,
      decisionBody.extend({ token: z.string().min(1).max(200) }),
    );
    const registration = await findRegistrationByApprovalToken(token);
    if (decision === "reject") {
      await rejectRegistration(registration);
      return c.json({ status: "rejected" });
    }
    const { agent, sessionToken } = await approveRegistration(registration, { startSession: true });
    if (sessionToken) setSessionCookie(c, sessionToken);
    return c.json({ status: "approved", agent: ownerView(agent) });
  })
  .get("/v1/registrations", requireOwner, async (c) => {
    const registrations = await listPendingRegistrations(c.get("owner"));
    return c.json({ registrations: registrations.map(ownerRegistrationView) });
  })
  .post("/v1/registrations/:id", requireOwner, async (c) => {
    const id = parseWith(z.uuid(), c.req.param("id"));
    const { decision } = await parseBody(c, decisionBody);
    const registration = await findOwnedRegistration(c.get("owner"), id);
    if (decision === "reject") {
      await rejectRegistration(registration);
      return c.json({ status: "rejected" });
    }
    const { agent } = await approveRegistration(registration, { startSession: false });
    return c.json({ status: "approved", agent: ownerView(agent) });
  });
