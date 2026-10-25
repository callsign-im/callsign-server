import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type HookScope = "user" | "project" | "local";

type HookEntry = { type: "command"; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

export const HOOK_COMMAND = "callsign hook";
const EVENTS: { event: string; matcher?: string }[] = [
  { event: "PostToolUse", matcher: "*" },
  { event: "Stop" },
];

export function settingsPath(scope: HookScope, cwd: string, home = homedir()): string {
  if (scope === "user") return join(home, ".claude", "settings.json");
  return join(cwd, ".claude", scope === "local" ? "settings.local.json" : "settings.json");
}

// Adds the Callsign hook to Claude Code's settings, keeping everything already there. Running it
// twice changes nothing.
export async function installHooks(path: string): Promise<{ added: string[] }> {
  let settings: Settings = {};
  try {
    settings = JSON.parse(await readFile(path, "utf8")) as Settings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `couldn't read ${path}: ${err instanceof Error ? err.message : String(err)}`,
        {
          cause: err,
        },
      );
    }
  }
  const hooks = (settings.hooks ??= {});
  const added: string[] = [];
  for (const { event, matcher } of EVENTS) {
    const groups = (hooks[event] ??= []);
    const present = groups.some((group) =>
      group.hooks.some((hook) => hook.command.startsWith(HOOK_COMMAND)),
    );
    if (present) continue;
    groups.push({
      ...(matcher && { matcher }),
      hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 10 }],
    });
    added.push(event);
  }
  if (added.length > 0) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { added };
}

export type HookConfig = { token: string; api?: string };

export function hookConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "callsign", "hook.json");
}

export async function saveHookConfig(path: string, config: HookConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
}

export async function loadHookConfig(path: string): Promise<HookConfig | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as HookConfig;
  } catch {
    return null;
  }
}
