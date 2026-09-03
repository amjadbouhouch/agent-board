/**
 * The single place the SQLite driver is imported. Everything else in the
 * codebase goes through here, so swapping `bun:sqlite` for `node:sqlite` or a
 * future adapter touches one file rather than the whole
 * tree — and keeps npm distribution options open.
 */
import { Database } from "bun:sqlite";

export type { Database };

export interface OpenOptions {
  /** Create the file if it does not exist. */
  create?: boolean;
  /** Refuse writes for the lifetime of the connection. */
  readOnly?: boolean;
}

/**
 * How long a connection waits for a lock before giving up. SQLite's default is
 * zero, which makes two connections opening the same WAL database at the same
 * instant fail with SQLITE_BUSY rather than queue.
 */
export const BUSY_TIMEOUT_MS = 5_000;

/**
 * Opens a workspace database. Connections are never opened with the driver's
 * readonly flag: a readonly connection to a WAL database cannot create the
 * -shm file and fails with SQLITE_CANTOPEN. `PRAGMA query_only` gives the same
 * guarantee on a writable handle.
 */
export function open(path: string, options: OpenOptions = {}): Database {
  // bun:sqlite rejects { create: false } on its own — the access mode must be explicit.
  const db = new Database(path, { create: options.create ?? false, readwrite: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  if (options.readOnly) db.exec("PRAGMA query_only = ON;");
  return db;
}

/** Provisions a new database file with WAL journaling enabled. */
export function create(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  return db;
}

/** Flushes the WAL into the main file so it can be copied or exported safely. */
export function checkpoint(path: string): void {
  const db = open(path);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
}

/** Quotes an SQL identifier. The name must already be known-good. */
export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
