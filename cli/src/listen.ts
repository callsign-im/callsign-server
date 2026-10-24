import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { relevant, summarize, wakePrompt, type GroupMode } from "./activity.ts";
import { ApiError, type Client, type Notification } from "./api.ts";

export type Runner = (prompt: string) => Promise<number>;

export type FeedOptions = {
  client: Client;
  groups: GroupMode;
  signal: AbortSignal;
  log: (line: string) => void;
  waitSeconds?: number;
  settleMs?: number;
};

const RETRY_MS = [1_000, 5_000, 15_000, 30_000, 60_000];
const DEFAULT_WAIT_SECONDS = 50;
const DEFAULT_SETTLE_MS = 2_000;

function quiet(signal: AbortSignal, ms: number): Promise<void> {
  return sleep(ms, undefined, { signal }).catch(() => undefined);
}

// Long-polls the feed and hands each burst of relevant activity to `handle`, one at a time.
export async function follow(
  options: FeedOptions,
  handle: (batch: Notification[], unread: number) => void | Promise<void>,
  start: (unread: number) => void | Promise<void>,
): Promise<void> {
  const { client, groups, signal, log } = options;
  const wait = options.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  let { cursor, unread } = await client.notifications(undefined, 0, signal);
  await start(unread);
  let failures = 0;

  while (!signal.aborted) {
    try {
      const feed = await client.notifications(cursor, wait, signal);
      failures = 0;
      cursor = feed.cursor;
      unread = feed.unread;
      const batch = feed.notifications.filter((n) => relevant(n, groups));
      if (batch.length === 0 || unread === 0) continue;
      const settle = options.settleMs ?? DEFAULT_SETTLE_MS;
      if (settle > 0) {
        await quiet(signal, settle);
        const more = await client.notifications(cursor, 0, signal);
        cursor = more.cursor;
        unread = more.unread;
        batch.push(...more.notifications.filter((n) => relevant(n, groups)));
      }
      if (unread > 0) await handle(batch, unread);
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err;
      const delay = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)] ?? 60_000;
      failures += 1;
      log(`Couldn't reach Callsign (${err instanceof Error ? err.message : String(err)}).`);
      await quiet(signal, delay);
    }
  }
}

export type ListenOptions = FeedOptions & { run: Runner; once: boolean };

export async function listen(options: ListenOptions): Promise<void> {
  const { client, run, signal, log } = options;
  const handle = await client.whoami();

  async function wake(batch: Notification[], unread: number) {
    log(`Starting the agent: ${batch.length > 0 ? summarize(batch) : `${unread} unread`}.`);
    const code = await run(wakePrompt(handle, batch, unread));
    if (code !== 0) log(`The agent exited with code ${code}.`);
  }

  if (options.once) {
    const { unread } = await client.notifications(undefined, 0, signal);
    if (unread > 0) await wake([], unread);
    else log(`Nothing new for ${handle}.`);
    return;
  }

  await follow(options, wake, async (unread) => {
    log(`Listening as ${handle}. Press Ctrl+C to stop.`);
    if (unread > 0) await wake([], unread);
  });
}

export type Preset = "claude" | "codex";

// Splits a command line on spaces, keeping quoted parts together.
export function splitCommand(line: string): string[] {
  const parts = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((part) => part.replace(/^(["'])(.*)\1$/, "$2"));
}

export function commandFor(
  options: { preset: Preset; serverName: string; resume: boolean } | { command: string },
): (prompt: string) => string[] {
  if ("command" in options) {
    const parts = splitCommand(options.command);
    return (prompt) =>
      parts.includes("{prompt}")
        ? parts.map((part) => (part === "{prompt}" ? prompt : part))
        : [...parts, prompt];
  }
  if (options.preset === "codex") {
    return (prompt) => ["codex", "exec", "--skip-git-repo-check", prompt];
  }
  return (prompt) => [
    "claude",
    "-p",
    prompt,
    "--allowedTools",
    `mcp__${options.serverName}`,
    ...(options.resume ? ["--continue"] : []),
  ];
}

export function spawnRunner(argv: (prompt: string) => string[], cwd: string): Runner {
  return (prompt) =>
    new Promise((resolve) => {
      const [command, ...args] = argv(prompt);
      if (!command) return resolve(1);
      const child = spawn(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
      child.on("error", (err) => {
        process.stderr.write(`callsign: couldn't start ${command}: ${err.message}\n`);
        resolve(127);
      });
      child.on("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
    });
}
