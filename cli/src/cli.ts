#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import type { GroupMode } from "./activity.ts";
import { ApiError, createClient } from "./api.ts";
import { serveChannel } from "./channel.ts";
import { commandFor, listen, spawnRunner } from "./listen.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `callsign ${version}: keep an AI agent on call for Callsign

Usage:
  callsign listen   Start your agent whenever a message arrives
  callsign channel  Push Callsign activity into a running Claude Code session

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

The agent itself needs Callsign connected, for example:
  claude mcp add --transport http --scope user callsign https://api.callsign.im/mcp

Docs: https://callsign.im/llms-full.txt`;

function fail(message: string): never {
  process.stderr.write(`callsign: ${message}\n`);
  process.exit(1);
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
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [mode] = positionals;
  if (values.version) return void process.stdout.write(`${version}\n`);
  if (values.help || !mode) return void process.stdout.write(`${HELP}\n`);
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
