import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "../cli/src/api.ts";
import { handleHook, summarize, type HookInput } from "../cli/src/hook.ts";
import { installHooks } from "../cli/src/install-hooks.ts";
import { scrub } from "../cli/src/scrub.ts";
import { createGroup, respondToGroupInvite } from "../src/domain/groups.ts";
import {
  getLiveSession,
  startLiveSession,
  steerLiveSession,
  takeOverLiveSession,
} from "../src/domain/live-sessions.ts";
import { createAgentWithToken, startServer } from "./helpers.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let dir: string;

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "callsign-hook-"));
  return () => rm(dir, { recursive: true, force: true });
});

const claude = "claude-session-1";

function postToolUse(tool: string, input: Record<string, unknown>, response?: unknown): HookInput {
  return {
    session_id: claude,
    cwd: "/work/billing",
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input: input,
    tool_response: response,
  };
}

describe("callsign hook", () => {
  it("finds the session id in text results too", async () => {
    const statePath = join(dir, "sessions.json");
    const id = "01a17442-cc75-791b-ab89-76c984abca81";
    await handleHook(
      postToolUse("mcp__callsign__start_session", { title: "T" }, [
        { type: "text", text: `Started the live session "T" (session ${id}).` },
      ]),
      { client: createClient(server.url, "csk_unused"), statePath },
    ).catch(() => undefined);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ [claude]: { live: id } });
  });

  it("sums up each tool call in one line", () => {
    expect(
      summarize(
        postToolUse(
          "Bash",
          { command: "npm test" },
          { stdout: "> vitest\n\n 31 passed\n 0 failed\nmore" },
        ),
      ),
    ).toEqual({ kind: "tool", text: "$ npm test\n> vitest\n 31 passed\n 0 failed" });
    expect(
      summarize(
        postToolUse("Edit", {
          file_path: "/work/billing/models.py",
          old_string: "phone: str",
          new_string: "phone: str\nphone_number: str",
        }),
      ),
    ).toEqual({ kind: "diff", text: "Edited models.py (+2 −1)" });
    expect(
      summarize(
        postToolUse("TodoWrite", {
          todos: [{ content: "Write the migration", status: "in_progress" }],
        }),
      ),
    ).toEqual({ kind: "step", text: "Working on: Write the migration" });
    expect(summarize(postToolUse("mcp__callsign__send_message", { to: "@x" }))).toBeNull();
    expect(summarize(postToolUse("mcp__github__create_issue", {}))).toEqual({
      kind: "tool",
      text: "Used github: create_issue",
    });
  });

  it("keeps credentials out of what it reports", () => {
    expect(scrub("curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnop' x", [])).toBe(
      "curl -H 'Authorization: Bearer [secret]' x",
    );
    expect(scrub("export STRIPE_API_KEY=sk_live_1234567890abcdef1234", [])).toBe(
      "export STRIPE_API_KEY=[secret]",
    );
    expect(scrub("psql postgres://app:hunter2@db:5432/x", [])).toBe(
      "psql postgres://app:[secret]@db:5432/x",
    );
    expect(scrub("echo my-very-own-value", ["my-very-own-value"])).toBe("echo [secret]");
  });

  it("reports steps to the session the agent opened and hands back corrections", async () => {
    const tomas = await createAgentWithToken("tomas_agent");
    const mateo = await createAgentWithToken("mateo_agent");
    await createGroup(tomas.agent, { name: "#socios", members: ["@mateo_agent"] });
    await respondToGroupInvite(mateo.agent, "#socios", "accept", "agent");
    const deps = {
      client: createClient(server.url, tomas.token),
      statePath: join(dir, "sessions.json"),
      env: { DEPLOY_TOKEN: "super-secret-deploy-token" },
    };

    expect(await handleHook(postToolUse("Bash", { command: "ls" }), deps)).toBeNull();

    const session = await startLiveSession(
      tomas.agent,
      { title: "Billing", group: "#socios" },
      null,
    );
    // Claude Code passes MCP results to hooks as the serialized structured result.
    await handleHook(
      postToolUse(
        "mcp__callsign__start_session",
        { title: "Billing" },
        JSON.stringify({ session: { id: session.id, title: "Billing" } }),
      ),
      deps,
    );
    expect(
      await handleHook(
        postToolUse("Bash", { command: "deploy --token super-secret-deploy-token" }),
        deps,
      ),
    ).toBeNull();
    expect((await getLiveSession(tomas.agent, session.id)).events.at(-1)).toMatchObject({
      kind: "tool",
      text: "$ deploy --token [secret]",
    });

    await steerLiveSession(mateo.agent, session.id, "Keep the phone column.");
    const output = await handleHook(
      postToolUse("Read", { file_path: "/work/billing/client.py" }),
      deps,
    );
    expect(output).toMatchObject({ hookSpecificOutput: { hookEventName: "PostToolUse" } });
    expect(JSON.stringify(output)).toContain("Keep the phone column.");

    await steerLiveSession(mateo.agent, session.id, "And tell me when it's done.");
    const stop = await handleHook({ session_id: claude, hook_event_name: "Stop" }, deps);
    expect(stop).toMatchObject({ decision: "block" });
    expect(JSON.stringify(stop)).toContain("And tell me when it's done.");
    expect(await handleHook({ session_id: claude, hook_event_name: "Stop" }, deps)).toBeNull();

    await takeOverLiveSession(mateo.agent, session.id);
    expect(await handleHook(postToolUse("Bash", { command: "ls" }), deps)).toBeNull();
    expect(JSON.parse(await readFile(deps.statePath, "utf8"))).toEqual({});
  });

  it("adds itself to Claude Code's settings once, keeping what's there", async () => {
    const path = join(dir, ".claude", "settings.json");
    await installHooks(path).catch(() => undefined);
    await writeFile(
      path,
      JSON.stringify({
        model: "opus",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
      }),
    );
    expect(await installHooks(path)).toEqual({ added: ["PostToolUse", "Stop"] });
    expect(await installHooks(path)).toEqual({ added: [] });
    const settings = JSON.parse(await readFile(path, "utf8")) as {
      model: string;
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop?.map((group) => group.hooks[0]?.command)).toEqual([
      "say done",
      "callsign hook",
    ]);
    expect(settings.hooks.PostToolUse).toEqual([
      { matcher: "*", hooks: [{ type: "command", command: "callsign hook", timeout: 10 }] },
    ]);
  });
});
