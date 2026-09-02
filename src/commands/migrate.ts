import { open } from "../lib/db.ts";
import { loadConfig, workspacesRoot, CliError } from "../lib/config.ts";
import {
  openWorkspace,
  readMetadata,
  writeMetadata,
  createSnapshot,
  restoreSnapshot,
} from "../lib/workspace.ts";
import { appliedMigrations, applyPending, readMigrationFiles } from "../lib/migrations.ts";

export async function cmdMigrate(args: string[]): Promise<number> {
  const [id] = args;
  if (!id) throw new CliError("Usage: agent-board migrate <workspace>");

  const config = await loadConfig();
  const ws = openWorkspace(workspacesRoot(config), id);
  const migrations = await readMigrationFiles(ws);
  if (migrations.length === 0) {
    console.log(`No migration files in ${ws.migrationsDir}. Add NNNN_name.sql files first.`);
    return 0;
  }

  {
    const db = open(ws.dbPath);
    const maxApplied = appliedMigrations(db).at(-1)?.version ?? 0;
    db.close();
    if (!migrations.some((m) => m.version > maxApplied)) {
      console.log(`Workspace "${id}" is up to date (database v${maxApplied}).`);
      return 0;
    }
  }

  // Snapshot before structural changes.
  const snapshot = await createSnapshot(ws, "pre-migrate");
  console.log(`Snapshot #${snapshot.seq} created.`);

  const db = open(ws.dbPath);
  try {
    const result = applyPending(db, migrations);
    db.close();
    for (const m of result.applied) console.log(`Applied v${m.version}  ${m.file}`);

    const metadata = await readMetadata(ws);
    metadata.dbVersion = result.newVersion;
    await writeMetadata(ws, metadata);
    console.log(`Workspace "${id}" is now at database v${result.newVersion}.`);
    return 0;
  } catch (error) {
    db.close();
    await restoreSnapshot(ws, snapshot.seq);
    console.error(`Migration failed — restored snapshot #${snapshot.seq}.`);
    if (error instanceof CliError) throw error;
    throw new CliError((error as Error).message);
  }
}
