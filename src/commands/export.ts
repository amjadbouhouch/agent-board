import { resolve } from "node:path";
import { checkpoint } from "../lib/db.ts";
import { loadConfig, workspacesRoot, CliError } from "../lib/config.ts";
import { openWorkspace } from "../lib/workspace.ts";

export async function cmdExport(args: string[]): Promise<number> {
  const [id, out] = args;
  if (!id) throw new CliError("Usage: agent-board export <workspace> [out.tar.gz]");

  const config = await loadConfig();
  const root = workspacesRoot(config);
  const ws = openWorkspace(root, id);

  // Checkpoint WAL so the exported database file is self-contained.
  checkpoint(ws.dbPath);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = resolve(out ?? `${id}-${stamp}.tar.gz`);

  const proc = Bun.spawn(
    [
      "tar", "czf", target,
      "--exclude", "snapshots",
      "--exclude", "data.sqlite-wal",
      "--exclude", "data.sqlite-shm",
      "-C", root, id,
    ],
    { stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new CliError(`tar failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  console.log(`Exported workspace "${id}" to ${target}`);
  return 0;
}
