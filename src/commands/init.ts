import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CONFIG_FILE, DEFAULT_CONFIG } from "../lib/config.ts";

export async function cmdInit(): Promise<number> {
  const cwd = process.cwd();
  const configPath = resolve(cwd, CONFIG_FILE);
  if (existsSync(configPath)) {
    console.log(`${CONFIG_FILE} already exists — nothing to do.`);
    return 0;
  }
  await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  await mkdir(resolve(cwd, DEFAULT_CONFIG.workspacesDir), { recursive: true });
  console.log(`Initialized AgentBoard project.`);
  console.log(`  ${CONFIG_FILE}`);
  console.log(`  ${DEFAULT_CONFIG.workspacesDir}/`);
  console.log(`\nNext: agent-board workspace create <name>`);
  return 0;
}
