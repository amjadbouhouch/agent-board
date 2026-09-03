import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "./db.ts";
import { CliError } from "./config.ts";
import type { Workspace } from "./workspace.ts";

export interface MigrationFile {
  version: number;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

/** Platform-owned migration ledger, in the protected `_agentboard_` namespace. */
const LEDGER_TABLE = "_agentboard_migrations";

/** Platform-owned namespaces, closed to both migrations and row writes. */
export const PROTECTED_PREFIXES = ["_agentboard_", "_auth_", "_audit_"];

/** Statements the CLI refuses inside agent-authored migrations. */
const FORBIDDEN_SQL = [
  /\bATTACH\b/i,
  /\bDETACH\b/i,
  /\bload_extension\b/i,
  /\bPRAGMA\b/i,
  /\bVACUUM\b/i,
];

export function ensureLedger(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      sql        TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

export function appliedMigrations(db: Database): AppliedMigration[] {
  const ledger = db
   .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
   .get(LEDGER_TABLE);
  if (!ledger) return [];
  return db
   .query<AppliedMigration, []>(
      `SELECT version, name, checksum, applied_at FROM ${LEDGER_TABLE} ORDER BY version`,
    )
   .all();
}

function checksum(sql: string): string {
  return new Bun.CryptoHasher("sha256").update(sql).digest("hex");
}

/** Reads migrations/NNNN_name.sql files, sorted by version. */
export async function readMigrationFiles(ws: Workspace): Promise<MigrationFile[]> {
  if (!existsSync(ws.migrationsDir)) return [];
  const files = (await readdir(ws.migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const migrations: MigrationFile[] = [];
  for (const file of files) {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      throw new CliError(
        `Migration file "${file}" does not match NNNN_name.sql (e.g. 0001_initial.sql).`,
      );
    }
    const sql = await readFile(join(ws.migrationsDir, file), "utf8");
    migrations.push({
      version: Number(match[1]),
      name: match[2]!,
      file,
      sql,
      checksum: checksum(sql),
    });
  }
  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new CliError(`Duplicate migration version ${m.version} in ${ws.migrationsDir}.`);
    }
    seen.add(m.version);
  }
  return migrations;
}

/** Static safety checks on migration SQL. Returns error strings, empty when valid. */
export function validateMigrationSql(sql: string): string[] {
  const errors: string[] = [];
  for (const pattern of FORBIDDEN_SQL) {
    if (pattern.test(sql)) {
      errors.push(`Forbidden statement matched ${pattern} — not allowed in migrations.`);
    }
  }
  for (const prefix of PROTECTED_PREFIXES) {
    if (sql.toLowerCase().includes(prefix)) {
      errors.push(`References protected namespace "${prefix}*" — platform-owned tables.`);
    }
  }
  return errors;
}

export interface MigrateResult {
  applied: MigrationFile[];
  newVersion: number;
}

/**
 * Applies all pending migrations in one transaction each, verifying checksums
 * of already-applied migrations and running an integrity check afterwards.
 * Caller is responsible for snapshotting first.
 */
export function applyPending(db: Database, migrations: MigrationFile[]): MigrateResult {
  ensureLedger(db);
  const applied = appliedMigrations(db);
  const appliedByVersion = new Map(applied.map((m) => [m.version, m]));

  for (const m of migrations) {
    const prior = appliedByVersion.get(m.version);
    if (prior && prior.checksum !== m.checksum) {
      throw new CliError(
        `Migration ${m.file} was already applied with a different checksum. ` +
          `Applied: ${prior.checksum.slice(0, 12)}…, on disk: ${m.checksum.slice(0, 12)}…`,
      );
    }
  }

  const maxApplied = applied.at(-1)?.version ?? 0;
  const pending = migrations.filter((m) => m.version > maxApplied);

  for (const m of pending) {
    const errors = validateMigrationSql(m.sql);
    if (errors.length > 0) {
      throw new CliError(`Migration ${m.file} failed validation:\n  - ${errors.join("\n  - ")}`);
    }
    const insert = db.prepare(
      `INSERT INTO ${LEDGER_TABLE} (version, name, checksum, sql) VALUES (?, ?, ?, ?)`,
    );
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.version, m.name, m.checksum, m.sql);
    })();
  }

  if (pending.length > 0) {
    const check = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check;").get();
    if (check?.integrity_check !== "ok") {
      throw new CliError(`Integrity check failed after migration: ${check?.integrity_check}`);
    }
  }

  return {
    applied: pending,
    newVersion: appliedMigrations(db).at(-1)?.version ?? maxApplied,
  };
}

/** Business tables only — filters out platform ledger and SQLite internals. */
export function listBusinessTables(db: Database): { name: string; rows: number }[] {
  const tables = db
   .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
   .all()
   .filter((t) => !PROTECTED_PREFIXES.some((p) => t.name.startsWith(p)));
  return tables.map((t) => {
    const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${t.name}"`).get();
    return { name: t.name, rows: row?.n ?? 0 };
  });
}
