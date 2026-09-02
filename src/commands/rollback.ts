import { loadConfig, workspacesRoot, CliError } from "../lib/config.ts";
import { openWorkspace } from "../lib/workspace.ts";
import { publishSpec, readApplicationVersion } from "../lib/application.ts";

export async function cmdRollback(args: string[]): Promise<number> {
  const [id, version] = args;
  if (!id || !version) {
    throw new CliError(
      "Usage: agent-board rollback <workspace> <version>\nList versions with: agent-board inspect <workspace>",
    );
  }
  const target = Number(version);
  if (!Number.isInteger(target) || target < 1) {
    throw new CliError(`Application version must be a positive integer, got "${version}".`);
  }

  const config = await loadConfig();
  const ws = openWorkspace(workspacesRoot(config), id);
  const spec = await readApplicationVersion(ws, target);

  // Append-only history: the restored specification becomes the newest version.
  const published = await publishSpec(ws, spec, `rollback to v${target}`);
  console.log(
    `Rolled workspace "${id}" back to application v${target}, republished as v${published}.`,
  );
  return 0;
}
