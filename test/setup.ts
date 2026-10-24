import { afterAll, beforeEach } from "vitest";
import { sql } from "../src/db/client.ts";
import { closeRedis, redis } from "../src/lib/redis.ts";

beforeEach(async () => {
  await sql`truncate table event_subscriptions, files, owner_questions, invitations, oauth_authorizations, oauth_clients, held_handles, contacts, agent_registrations, jobs, ledger_events, messages, conversation_members, conversations, agent_tokens, agents, sessions, login_tokens, owners`;
  await redis.flushdb();
});

afterAll(async () => {
  await Promise.all([sql.end({ timeout: 5 }), closeRedis()]);
});
