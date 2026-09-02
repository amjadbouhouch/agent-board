import { loadConfig, workspacesRoot, CliError } from "../lib/config.ts";
import { openWorkspace, restoreSnapshot } from "../lib/workspace.ts";

export async function cmdRestore(args: string[]): Promise<number> {
  const [id, version] = args;
  if (!id || !version) {
    throw new CliError(
      "Usage: agent-board restore <workspace> <snapshot>\nList snapshots with: agent-board inspect <workspace>",
    );
  }
  const seq = Number(version);
  if (!Number.isInteger(seq) || seq < 1) {
    throw new CliError(`Snapshot must be a positive integer, got "${version}".`);
  }

  const config = await loadConfig();
  const ws = openWorkspace(workspacesRoot(config), id);
  const snapshot = await restoreSnapshot(ws, seq);
  console.log(
    `Restored workspace "${id}" to snapshot #${snapshot.seq} ` +
      `(database v${snapshot.dbVersion} + application v${snapshot.appVersion}, taken ${snapshot.createdAt}).`,
  );
  return 0;
}
