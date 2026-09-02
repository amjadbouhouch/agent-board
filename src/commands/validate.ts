import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { CliError } from "../lib/config.ts";
import { validateApplication } from "../lib/dsl.ts";

export async function cmdValidate(args: string[]): Promise<number> {
  const [path] = args;
  if (!path) throw new CliError("Usage: agent-board validate <application.json>");
  if (!existsSync(path)) throw new CliError(`File not found: ${path}`);

  let spec: unknown;
  try {
    spec = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CliError(`${path} is not valid JSON: ${(error as Error).message}`);
  }

  const errors = validateApplication(spec);
  if (errors.length === 0) {
    console.log(`${path} is a valid application specification.`);
    return 0;
  }
  console.error(`${path} failed validation with ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  return 1;
}
