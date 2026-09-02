import { open } from "../lib/db.ts";
import { loadConfig, workspacesRoot, CliError } from "../lib/config.ts";
import { openWorkspace, readMetadata, listSnapshots } from "../lib/workspace.ts";
import { appliedMigrations, listBusinessTables, readMigrationFiles } from "../lib/migrations.ts";
import { listApplicationVersionRecords, readCurrentApplication } from "../lib/application.ts";

export async function cmdInspect(args: string[]): Promise<number> {
  const [id] = args;
  if (!id) throw new CliError("Usage: agent-board inspect <workspace>");

  const config = await loadConfig();
  const ws = openWorkspace(workspacesRoot(config), id);
  const metadata = await readMetadata(ws);

  console.log(`Workspace: ${metadata.id} (“${metadata.name}”)`);
  console.log(`Created:   ${metadata.createdAt}`);
  console.log(`Versions:  database v${metadata.dbVersion} + application v${metadata.appVersion}`);

  const db = open(ws.dbPath);
  try {
    const tables = listBusinessTables(db);
    console.log(`\nTables (${tables.length}):`);
    if (tables.length === 0) console.log("  (none)");
    for (const t of tables) console.log(`  ${t.name}  —  ${t.rows} row${t.rows === 1 ? "" : "s"}`);

    const applied = appliedMigrations(db);
    const onDisk = await readMigrationFiles(ws);
    const maxApplied = applied.at(-1)?.version ?? 0;
    const pending = onDisk.filter((m) => m.version > maxApplied);
    console.log(`\nMigrations (${applied.length} applied, ${pending.length} pending):`);
    for (const m of applied) {
      console.log(`  v${m.version}  ${m.name}  applied ${m.applied_at}`);
    }
    for (const m of pending) {
      console.log(`  v${m.version}  ${m.name}  PENDING (${m.file})`);
    }
  } finally {
    db.close();
  }

  const app = (await readCurrentApplication(ws)) as Record<string, unknown>;
  const pages = Array.isArray(app.pages) ? app.pages.length : 0;
  const queries = Array.isArray(app.savedQueries) ? app.savedQueries.length : 0;
  console.log(`\nApplication: “${app.title}” — ${pages} page(s), ${queries} saved quer${queries === 1 ? "y" : "ies"}`);

  const versions = await listApplicationVersionRecords(ws);
  console.log(`\nApplication versions (${versions.length}):`);
  for (const v of versions) {
    console.log(`  v${v.version}  ${v.createdAt}  ${v.reason}`);
  }

  const snapshots = await listSnapshots(ws);
  console.log(`\nSnapshots (${snapshots.length}):`);
  for (const s of snapshots) {
    console.log(
      `  #${s.seq}  db v${s.dbVersion} + app v${s.appVersion}  ${s.createdAt}  (${s.reason})`,
    );
  }
  return 0;
}
