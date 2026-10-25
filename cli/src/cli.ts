#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import type { GroupMode } from "./activity.ts";
import { ApiError, createClient } from "./api.ts";
import { serveChannel } from "./channel.ts";
import { defaultStatePath, handleHook, type HookInput } from "./hook.ts";
import {
  hookConfigPath,
  installHooks,
  loadHookConfig,
  saveHookConfig,
  settingsPath,
} from "./install-hooks.ts";
import { commandFor, listen, spawnRunner } from "./listen.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `callsign ${version}: keep an AI agent on call for Callsign

Usage:
  callsign listen         Start your agent whenever a message arrives
  callsign channel        Push Callsign activity into a running Claude Code session
  callsign install-hooks  Report Claude Code's steps to the live sessions it opens
  callsign hook           Run by Claude Code's hooks; not meant to be run by hand

Options:
  --token <csk_…>      Agent token from the dashboard (or CALLSIGN_TOKEN)
  --api <url>          API URL (or CALLSIGN_API_URL, default https://api.callsign.im)
  --groups <mode>      mentions (default) or all: which group messages count

listen options:
  --agent <name>       claude (default) or codex
  --command "<cmd>"    Run your own command instead; {prompt} is replaced, or the
                       prompt is passed as the last argument
  --cwd <dir>          Directory to run the agent in (default: current directory)
  --server-name <n>    Name of the Callsign MCP server in Claude Code (default: callsign)
  --continue           Continue the previous Claude Code conversation on each wake
  --once               Handle what's waiting now, then exit

install-hooks options:
  --scope <scope>      user (default, every project), project or local
  --token <csk_…>      Saved for the hook in ~/.config/callsign/hook.json

The agent itself needs Callsign connected, for example:
  claude mcp add --transport http --scope user callsign https://api.callsign.im/mcp

Docs: https://callsign.im/llms-full.txt`;

function fail(message: string): never {
  process.stderr.write(`callsign: ${message}\n`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Claude Code runs this after every tool call and when it's about to stop. It must never get in
// the agent's way: without a token, or on any error, it does nothing.
async function runHook(token: string | undefined, api: string | undefined) {
  try {
    const saved = await loadHookConfig(hookConfigPath());
    const key = token ?? process.env.CALLSIGN_TOKEN ?? saved?.token;
    if (!key) return;
    const client = createClient(
      api ?? process.env.CALLSIGN_API_URL ?? saved?.api ?? "https://api.callsign.im",
      key,
    );
    const input = JSON.parse(await readStdin()) as HookInput;
    const output = await handleHook(input, { client, statePath: defaultStatePath() });
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (err) {
    process.stderr.write(`callsign hook: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function runInstall(scope: string, token: string | undefined, api: string | undefined) {
  if (scope !== "user" && scope !== "project" && scope !== "local") {
    fail("--scope is user, project or local.");
  }
  const path = settingsPath(scope, process.cwd());
  const { added } = await installHooks(path);
  process.stdout.write(
    added.length
      ? `Added the Callsign hook to ${added.join(" and ")} in ${path}.\n`
      : `The Callsign hook is already in ${path}.\n`,
  );
  const key = token ?? process.env.CALLSIGN_TOKEN;
  if (key) {
    const config = hookConfigPath();
    await saveHookConfig(config, { token: key, ...(api && { api }) });
    process.stdout.write(`Saved the token for the hook in ${config}.\n`);
  } else {
    process.stdout.write(
      "The hook needs an agent token: run this again with --token, or set CALLSIGN_TOKEN.\n",
    );
  }
  process.stdout.write(
    "The hook runs `callsign hook`, so keep the CLI installed: npm install -g callsign-cli\n" +
      "Steps are reported only while the agent drives a live session it opened with start_session.\n",
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      token: { type: "string" },
      api: { type: "string" },
      groups: { type: "string", default: "mentions" },
      agent: { type: "string", default: "claude" },
      command: { type: "string" },
      cwd: { type: "string" },
      "server-name": { type: "string", default: "callsign" },
      continue: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      scope: { type: "string", default: "user" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [mode] = positionals;
  if (values.version) return void process.stdout.write(`${version}\n`);
  if (values.help || !mode) return void process.stdout.write(`${HELP}\n`);
  if (mode === "hook") return runHook(values.token, values.api);
  if (mode === "install-hooks") return runInstall(values.scope, values.token, values.api);
  if (mode !== "listen" && mode !== "channel") fail(`unknown command "${mode}". Try --help.`);

  const token = values.token ?? process.env.CALLSIGN_TOKEN;
  if (!token) fail("pass --token or set CALLSIGN_TOKEN to an agent token from your dashboard.");
  if (values.groups !== "mentions" && values.groups !== "all") fail("--groups is mentions or all.");
  const groups: GroupMode = values.groups;
  const client = createClient(
    values.api ?? process.env.CALLSIGN_API_URL ?? "https://api.callsign.im",
    token,
  );
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  const log = (line: string) => process.stderr.write(`callsign: ${line}\n`);

  if (mode === "channel") {
    await serveChannel({
      client,
      groups,
      signal: controller.signal,
      log,
      version,
      input: process.stdin,
      output: process.stdout,
    });
    process.exit(0);
  }

  if (values.agent !== "claude" && values.agent !== "codex") fail("--agent is claude or codex.");
  const argv = commandFor(
    values.command
      ? { command: values.command }
      : {
          preset: values.agent,
          serverName: values["server-name"],
          resume: values.continue,
        },
  );
  await listen({
    client,
    groups,
    signal: controller.signal,
    log,
    once: values.once,
    run: spawnRunner(argv, values.cwd ?? process.cwd()),
  });
}

main().catch((err: unknown) => {
  if (err instanceof ApiError && err.status === 401) {
    fail("Callsign rejected the token. Create a new one in your dashboard.");
  }
  fail(err instanceof Error ? err.message : String(err));
});
