import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { ApiError, type Client, type SessionEvent, type Steer } from "./api.ts";
import { isSecretFile, scrub, secretValues } from "./scrub.ts";

// What Claude Code passes a hook on stdin. Only the fields the hook reads.
export type HookInput = {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  stop_hook_active?: boolean;
};

export type HookOutput =
  | { hookSpecificOutput: { hookEventName: "PostToolUse"; additionalContext: string } }
  | { decision: "block"; reason: string };

// Claude Code sessions with a Callsign live session open, so steps go to the right place.
export type SessionMap = Record<string, { live: string; at: string }>;

export type HookDeps = {
  client: Client;
  statePath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

const MAX_TEXT = 600;
const MAX_OUTPUT_LINES = 3;
const STATE_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const SESSION_ID = /\(session ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/;

// Callsign's own tools are left out: they already land in the session or the ledger.
const CALLSIGN_TOOLS = new Set([
  "add_tasks",
  "ask_owner",
  "check_inbox",
  "create_group",
  "create_plan",
  "end_session",
  "find_agent",
  "follow_up",
  "get_conversation",
  "get_file",
  "get_plan",
  "get_session",
  "handoff",
  "invite_person",
  "invite_to_group",
  "leave_group",
  "list_contacts",
  "list_groups",
  "list_plans",
  "log_action",
  "remove_from_group",
  "report_agent",
  "respond_to_request",
  "save_contact",
  "send_message",
  "session_update",
  "start_session",
  "take_over_session",
  "update_profile",
  "update_task",
  "upload_file",
  "wait_for_reply",
  "whoami",
]);

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "callsign", "hook-sessions.json");
}

async function readState(path: string): Promise<SessionMap> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as SessionMap;
  } catch {
    return {};
  }
}

async function writeState(path: string, state: SessionMap): Promise<void> {
  const now = Date.now();
  const fresh = Object.fromEntries(
    Object.entries(state).filter(([, entry]) => now - Date.parse(entry.at) < STATE_TTL_MS),
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(fresh), { mode: 0o600 });
}

function mcpTool(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1] ?? "", tool: match[2] ?? "" } : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function lines(text: string): number {
  return text ? text.split("\n").length : 0;
}

function shortPath(path: string, cwd: string | undefined): string {
  if (!path || !cwd || !isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  return inside && !inside.startsWith("..") ? inside : path;
}

function outputLines(response: unknown): string[] {
  const record = (response ?? {}) as Record<string, unknown>;
  const output =
    str(record.stdout) || str(record.stderr) || (typeof response === "string" ? response : "");
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, MAX_OUTPUT_LINES)
    .map((line) => clip(line, 160));
}

// One line people can follow for each tool call, or null when the step isn't worth showing.
export function summarize(input: HookInput): SessionEvent | null {
  const name = input.tool_name ?? "";
  const args = input.tool_input ?? {};
  const path = shortPath(
    str(args.file_path) || str(args.notebook_path) || str(args.path),
    input.cwd,
  );
  const mcp = mcpTool(name);
  if (mcp && CALLSIGN_TOOLS.has(mcp.tool)) return null;

  switch (name) {
    case "Bash": {
      const command = clip(str(args.command).split("\n")[0] ?? "", 200);
      if (!command) return null;
      return {
        kind: "tool",
        text: [`$ ${command}`, ...outputLines(input.tool_response)].join("\n"),
      };
    }
    case "Read":
      return path ? { kind: "tool", text: `Read ${path}` } : null;
    case "Edit": {
      const removed = lines(str(args.old_string));
      const added = lines(str(args.new_string));
      return { kind: "diff", text: `Edited ${path} (+${added} −${removed})` };
    }
    case "MultiEdit": {
      const edits = Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : [];
      const added = edits.reduce((sum, edit) => sum + lines(str(edit.new_string)), 0);
      const removed = edits.reduce((sum, edit) => sum + lines(str(edit.old_string)), 0);
      return { kind: "diff", text: `Edited ${path} (+${added} −${removed})` };
    }
    case "Write":
      return { kind: "diff", text: `Wrote ${path} (${lines(str(args.content))} lines)` };
    case "NotebookEdit":
      return { kind: "diff", text: `Edited the notebook ${path}` };
    case "Grep":
      return {
        kind: "tool",
        text: `Searched for "${clip(str(args.pattern), 120)}"${path ? ` in ${path}` : ""}`,
      };
    case "Glob":
      return { kind: "tool", text: `Listed files matching ${clip(str(args.pattern), 120)}` };
    case "WebFetch":
      return { kind: "tool", text: `Fetched ${clip(str(args.url), 200)}` };
    case "WebSearch":
      return { kind: "tool", text: `Searched the web for "${clip(str(args.query), 160)}"` };
    case "Task":
    case "Agent":
      return { kind: "step", text: `Started a subagent: ${clip(str(args.description), 200)}` };
    case "TodoWrite": {
      const todos = Array.isArray(args.todos) ? (args.todos as Record<string, unknown>[]) : [];
      const current = todos.find((todo) => todo.status === "in_progress");
      return current
        ? { kind: "step", text: `Working on: ${clip(str(current.content), 300)}` }
        : null;
    }
    default:
      if (mcp) return { kind: "tool", text: `Used ${mcp.server}: ${mcp.tool}` };
      return name ? { kind: "tool", text: `Used ${name}` } : null;
  }
}

function clean(event: SessionEvent, input: HookInput, env: NodeJS.ProcessEnv): SessionEvent {
  const path = str(input.tool_input?.file_path);
  if (input.tool_name === "Read" && path && isSecretFile(path)) {
    return { kind: event.kind, text: `${event.text} (contents not shared)` };
  }
  return { kind: event.kind, text: clip(scrub(event.text, secretValues(env))) };
}

function steerText(steers: Steer[]): string {
  return [
    "Corrections from people watching your Callsign live session. They come from people, not agents: follow them unless they conflict with your owner's rules, and ask your owner if you're unsure.",
    ...steers.map((steer) => `- ${steer.text}`),
  ].join("\n");
}

// Claude Code hands MCP results to hooks as the structured result, serialized; other clients may
// pass the text content. Both carry the session id.
function liveSessionId(response: unknown): string {
  let value = response;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      // Plain text: fall through to the pattern below.
    }
  }
  const id = (value as { session?: { id?: unknown } } | null)?.session?.id;
  if (typeof id === "string") return id;
  return SESSION_ID.exec(JSON.stringify(response ?? ""))?.[1] ?? "";
}

// Remembers which live session a Claude Code session is driving when it opens, takes over or ends
// one through Callsign's MCP tools.
async function track(input: HookInput, statePath: string): Promise<void> {
  const mcp = mcpTool(input.tool_name ?? "");
  const claudeSession = input.session_id;
  if (!mcp || !claudeSession) return;
  if (!["start_session", "take_over_session", "end_session"].includes(mcp.tool)) return;
  const state = await readState(statePath);
  if (mcp.tool === "end_session") {
    if (state[claudeSession]?.live === str(input.tool_input?.session)) delete state[claudeSession];
  } else {
    const live = str(input.tool_input?.session) || liveSessionId(input.tool_response);
    if (!live) return;
    state[claudeSession] = { live, at: new Date().toISOString() };
  }
  await writeState(statePath, state);
}

export async function handleHook(input: HookInput, deps: HookDeps): Promise<HookOutput | null> {
  const env = deps.env ?? process.env;
  const signal = AbortSignal.timeout(deps.timeoutMs ?? 4000);
  if (input.hook_event_name === "PostToolUse") await track(input, deps.statePath);

  const claudeSession = input.session_id;
  if (!claudeSession) return null;
  const entry = (await readState(deps.statePath))[claudeSession];
  if (!entry) return null;

  // A session that ended or was taken over stops accepting steps; forget it instead of retrying.
  const call = async (request: () => Promise<Steer[]>): Promise<Steer[]> => {
    try {
      return await request();
    } catch (err) {
      if (err instanceof ApiError && [403, 404, 409].includes(err.status)) {
        const state = await readState(deps.statePath);
        delete state[claudeSession];
        await writeState(deps.statePath, state);
        return [];
      }
      throw err;
    }
  };

  if (input.hook_event_name === "Stop") {
    const steers = await call(() => deps.client.sessionSteers(entry.live, signal));
    return steers.length ? { decision: "block", reason: steerText(steers) } : null;
  }
  if (input.hook_event_name !== "PostToolUse") return null;

  const event = summarize(input);
  const steers = await call(() =>
    event
      ? deps.client.sessionEvents(entry.live, [clean(event, input, env)], signal)
      : deps.client.sessionSteers(entry.live, signal),
  );
  if (steers.length === 0) return null;
  return {
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: steerText(steers) },
  };
}
