import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadConfig, workspacesRoot, CliError } from "../lib/config.ts";
import { openWorkspace, readMetadata } from "../lib/workspace.ts";
import { publishSpec } from "../lib/application.ts";
import { validateApplication } from "../lib/dsl.ts";

interface PublishOptions {
  positional: string[];
  expectVersion?: number;
  reason: string;
}

function parseOptions(args: string[]): PublishOptions {
  const positional: string[] = [];
  let expectVersion: number | undefined;
  let reason = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--expect-version") {
      const raw = args[++i];
      if (raw === undefined) throw new CliError("--expect-version requires a number.");
      expectVersion = Number(raw);
      if (!Number.isInteger(expectVersion) || expectVersion < 0) {
        throw new CliError(`--expect-version must be a non-negative integer, got "${raw}".`);
      }
    } else if (arg === "--reason") {
      const raw = args[++i];
      if (raw === undefined) throw new CliError("--reason requires a message.");
      reason = raw;
    } else if (arg.startsWith("--")) {
      throw new CliError(`Unknown option "${arg}".`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, expectVersion, reason };
}

export async function cmdPublish(args: string[]): Promise<number> {
  const { positional, expectVersion, reason } = parseOptions(args);
  const [id, specPath] = positional;
  if (!id || !specPath) {
    throw new CliError(
      "Usage: agent-board publish <workspace> <application.json> " +
        "[--reason <message>] [--expect-version <n>]",
    );
  }
  if (!existsSync(specPath)) throw new CliError(`File not found: ${specPath}`);

  const config = await loadConfig();
  const ws = openWorkspace(workspacesRoot(config), id);

  // Optimistic concurrency, checked before anything is written.
  if (expectVersion !== undefined) {
    const { appVersion } = await readMetadata(ws);
    if (appVersion !== expectVersion) {
      throw new CliError(
        `Refusing to publish: expected application version ${expectVersion} ` +
          `but the workspace is at ${appVersion}.`,
      );
    }
  }

  const spec = JSON.parse(await readFile(specPath, "utf8"));
  const errors = validateApplication(spec);
  if (errors.length > 0) {
    throw new CliError(
      `${specPath} failed validation with ${errors.length} error(s):\n  - ${errors.join("\n  - ")}`,
    );
  }

  const version = await publishSpec(ws, spec, reason || "published via CLI");
  console.log(`Published application v${version} to workspace "${id}".`);
  return 0;
}
