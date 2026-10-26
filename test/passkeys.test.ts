import { and, eq, sql as where } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { jobs, ownerPasskeys, passkeyResets, sessions, type Owner } from "../src/db/schema.ts";
import { createAgent } from "../src/domain/agents.ts";
import { createSession } from "../src/domain/owners.ts";
import { runPasskeyReset } from "../src/domain/passkeys.ts";
import { createApp } from "../src/http/app.ts";
import { createOwner } from "./helpers.ts";
import { createPasskey, usePasskey, type SoftPasskey } from "./webauthn.ts";

const app = createApp();
const origin = "http://localhost:3001";

type Init = { method?: string; body?: unknown; origin?: string | null };
type Options = { challenge: string; rp: { id?: string }; rpId?: string };

async function signedIn() {
  const owner = await createOwner();
  const { sessionToken } = await createSession(db, owner.id);
  return { owner, cookie: `callsign_session=${sessionToken}` };
}

function call(cookie: string, path: string, init: Init = {}) {
  const headers: Record<string, string> = { cookie, "content-type": "application/json" };
  if (init.origin !== null) headers.origin = init.origin ?? origin;
  return app.request(path, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown> & {
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
}

async function addPasskey(cookie: string) {
  const { options } = (await json(
    await call(cookie, "/v1/me/passkeys/options", { method: "POST" }),
  )) as { options: Options };
  const { passkey, response } = createPasskey(options);
  const created = await call(cookie, "/v1/me/passkeys", {
    method: "POST",
    body: { response, name: "Laptop" },
  });
  return { passkey, created };
}

async function stepUpOptions(cookie: string): Promise<Options> {
  const res = await call(cookie, "/v1/me/step-up/options", { method: "POST" });
  return ((await json(res)) as { options: Options }).options;
}

async function stepUp(
  cookie: string,
  passkey: SoftPasskey,
  overrides: { origin?: string; counter?: number; rpId?: string } = {},
) {
  const options = await stepUpOptions(cookie);
  const response = usePasskey(
    passkey,
    { ...options, rpId: overrides.rpId ?? options.rpId },
    overrides,
  );
  return call(cookie, "/v1/me/step-up", { method: "POST", body: { response } });
}

async function ageSession(owner: Owner, minutes: number) {
  await db
    .update(sessions)
    .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
    .where(eq(sessions.ownerId, owner.id));
}

function jobsOf(kind: string, email: string) {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, kind), where`${jobs.payload}->>'email' = ${email}`));
}

describe("passkeys", () => {
  it("adds a first passkey only right after an email sign-in", async () => {
    const { owner, cookie } = await signedIn();
    await ageSession(owner, 20);
    const stale = await call(cookie, "/v1/me/passkeys/options", { method: "POST" });
    expect(stale.status).toBe(403);
    expect((await json(stale)).error?.details).toMatchObject({ reason: "fresh_login_required" });

    await ageSession(owner, 0);
    const { created } = await addPasskey(cookie);
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({ passkey: { name: "Laptop", backedUp: false } });
    expect(await jobsOf("email.passkey", owner.email)).toMatchObject([
      { payload: { change: "added", name: "Laptop" } },
    ]);

    const listed = await json(await call(cookie, "/v1/me/passkeys"));
    expect(listed).toMatchObject({ passkeys: [{ name: "Laptop" }], reset: null });
  });

  it("only runs ceremonies for requests from the dashboard", async () => {
    const { cookie } = await signedIn();
    const missing = await call(cookie, "/v1/me/passkeys/options", { method: "POST", origin: null });
    expect(missing.status).toBe(403);
    const elsewhere = await call(cookie, "/v1/me/step-up/options", {
      method: "POST",
      origin: "https://evil.example",
    });
    expect(elsewhere.status).toBe(403);
  });

  it("asks for the passkey before sensitive changes, for five minutes", async () => {
    const { owner, cookie } = await signedIn();
    await createAgent(owner, { handle: "stepupagent", product: "custom" });
    const before = await call(cookie, "/v1/agents/stepupagent/tokens", {
      method: "POST",
      body: { name: "Laptop" },
    });
    expect(before.status).toBe(201);

    const { passkey } = await addPasskey(cookie);
    const blocked = await call(cookie, "/v1/agents/stepupagent/tokens", {
      method: "POST",
      body: { name: "Server" },
    });
    expect(blocked.status).toBe(403);
    expect((await json(blocked)).error?.code).toBe("step_up_required");

    const harmless = await call(cookie, "/v1/agents/stepupagent", {
      method: "PATCH",
      body: { displayName: "Step Up", webhookUrl: null, rules: null },
    });
    expect(harmless.status).toBe(200);
    const redirect = await call(cookie, "/v1/agents/stepupagent", {
      method: "PATCH",
      body: { webhookUrl: "https://hooks.example.com/callsign" },
    });
    expect((await json(redirect)).error?.code).toBe("step_up_required");

    const elevated = await stepUp(cookie, passkey);
    expect(elevated.status).toBe(200);
    expect(await json(elevated)).toHaveProperty("elevatedUntil");
    const allowed = await call(cookie, "/v1/agents/stepupagent/tokens", {
      method: "POST",
      body: { name: "Server" },
    });
    expect(allowed.status).toBe(201);

    await db
      .update(sessions)
      .set({ elevatedUntil: new Date(Date.now() - 1000) })
      .where(eq(sessions.ownerId, owner.id));
    const expired = await call(cookie, "/v1/agents/stepupagent/tokens", {
      method: "POST",
      body: { name: "Later" },
    });
    expect((await json(expired)).error?.code).toBe("step_up_required");
  });

  it("rejects answers for another origin or site, replays and a counter going back", async () => {
    const { cookie } = await signedIn();
    const { passkey } = await addPasskey(cookie);

    expect((await stepUp(cookie, passkey, { origin: "https://evil.example" })).status).toBe(401);
    expect((await stepUp(cookie, passkey, { rpId: "evil.example" })).status).toBe(401);

    const options = await stepUpOptions(cookie);
    const response = usePasskey(passkey, options);
    const first = await call(cookie, "/v1/me/step-up", { method: "POST", body: { response } });
    expect(first.status).toBe(200);
    const replayed = await call(cookie, "/v1/me/step-up", { method: "POST", body: { response } });
    expect(replayed.status).toBe(400);

    expect((await stepUp(cookie, passkey, { counter: 1 })).status).toBe(401);
    expect((await stepUp(cookie, passkey, { counter: 50 })).status).toBe(200);
  });

  it("removes every passkey 72 hours after a reset request, unless it's cancelled", async () => {
    const { owner, cookie } = await signedIn();
    await addPasskey(cookie);

    await ageSession(owner, 20);
    const stale = await call(cookie, "/v1/me/passkeys/reset", { method: "POST" });
    expect((await json(stale)).error?.details).toMatchObject({ reason: "fresh_login_required" });
    await ageSession(owner, 0);

    const requested = await json(await call(cookie, "/v1/me/passkeys/reset", { method: "POST" }));
    const runAt = new Date((requested as { reset: { runAt: string } }).reset.runAt);
    expect(runAt.getTime() - Date.now()).toBeGreaterThan(71 * 3_600_000);
    const [scheduled] = await db.select().from(jobs).where(eq(jobs.kind, "passkey.reset"));
    expect(scheduled?.runAt.getTime()).toBe(runAt.getTime());
    const [mail] = await jobsOf("email.passkey", owner.email).then((rows) =>
      rows.filter((row) => row.payload.change === "reset_requested"),
    );
    const token = new URL(String(mail?.payload.cancelUrl)).searchParams.get("token") ?? "";

    expect(await json(await app.request(`/v1/passkey-resets/${token}`))).toMatchObject({
      reset: { status: "pending" },
    });
    const cancelled = await app.request(`/v1/passkey-resets/${token}/cancel`, {
      method: "POST",
    });
    expect(await json(cancelled)).toEqual({ cancelled: true });
    await runPasskeyReset({ resetId: String(scheduled?.payload.resetId) });
    expect(await db.select().from(ownerPasskeys)).toHaveLength(1);

    await call(cookie, "/v1/me/passkeys/reset", { method: "POST" });
    const [pending] = await db
      .select()
      .from(passkeyResets)
      .where(eq(passkeyResets.status, "pending"));
    await db
      .update(passkeyResets)
      .set({ runAt: new Date(Date.now() - 1000) })
      .where(eq(passkeyResets.id, pending!.id));
    await runPasskeyReset({ resetId: pending!.id });
    expect(await db.select().from(ownerPasskeys)).toHaveLength(0);
    expect((await jobsOf("email.passkey", owner.email)).map((row) => row.payload.change)).toContain(
      "reset_done",
    );
  });
});
