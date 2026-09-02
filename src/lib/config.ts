import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface AgentBoardConfig {
  workspacesDir: string;
}

export const CONFIG_FILE = "agent-board.json";

export const DEFAULT_CONFIG: AgentBoardConfig = {
  workspacesDir: "./workspaces",
};

export async function loadConfig(cwd = process.cwd()): Promise<AgentBoardConfig> {
  const path = resolve(cwd, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new CliError(
      `No ${CONFIG_FILE} found in ${cwd}. Run \`agent-board init\` first.`,
    );
  }
  const raw = JSON.parse(await readFile(path, "utf8"));
  return { ...DEFAULT_CONFIG, ...raw };
}

export function workspacesRoot(config: AgentBoardConfig, cwd = process.cwd()): string {
  return resolve(cwd, config.workspacesDir);
}

/** Error whose message is shown to the user without a stack trace. */
export class CliError extends Error {}
