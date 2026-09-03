/**
 * The single path by which rows are written.
 *
 * Migrations own schema — and the backfill that belongs with a schema change.
 * Everything else about data comes through here. The gates live in this module
 * rather than in the command, so the CLI today and an HTTP route later cannot
 * diverge on them, the same reason `runQuery` is the only way a saved query
 * executes.
 *
 * The caller never supplies write SQL. It names a table, columns and structured
 * filters, and this composes the statement, which is what makes scope and
 * injection structural rather than something a validator has to catch.
 */
import type { Database } from "./db.ts";
import { open } from "./db.ts";
import { CliError } from "./config.ts";
import { PROTECTED_PREFIXES } from "./migrations.ts";
import type { Workspace } from "./workspace.ts";

/** Applied changes beyond this need `--force`, so a bad filter cannot take a table. */
const MAX_AFFECTED_ROWS = 1000;

/** How many before-images one audit entry keeps, so `--force` cannot bloat the table. */
const AUDIT_IMAGE_LIMIT = 1000;

const AUDIT_TABLE = "_audit_row_changes";

export type Operation = "insert" | "update" | "delete";

/**
 * Ordered longest-first so a scan matching left to right cannot stop on the
 * `=` inside `!=`. `parseFilter` depends on this order; reordering it silently
 * changes how filters parse.
 */
export const FILTER_OPERATORS = ["!=", "<=", ">=", "=", "<", ">", "~"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** The token that means SQL NULL, so a bare `null` stays the literal text. */
export const NULL_TOKEN = "@null";

export interface Filter {
  column: string;
  operator: FilterOperator;
  value: unknown;
}

/** What bun:sqlite will bind. `coerce` is the only producer of these. */
type Binding = string | number | null;

export interface MutationResult {
  operation: Operation;
  table: string;
  affected: number;
  /** Set on a preview: present it to apply the change this preview described. */
  receipt?: string;
  applied: boolean;
  /** The rows as stored, when the caller asked for them back. */
  rows?: Record<string, unknown>[];
}

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

/** A table and its columns, which travel together everywhere below. */
interface TableInfo {
  name: string;
  columns: Column[];
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * SQLite's type affinity, reduced to what matters here: whether a column is
 * meant to hold a number. Storing "1,200" in an INTEGER column succeeds
 * under the affinity rules and silently poisons every later SUM(), so numeric
 * columns are checked rather than trusted to the driver.
 */
function isNumericAffinity(declared: string): boolean {
  const type = declared.toUpperCase();
  if (type.includes("INT")) return true;
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) return true;
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) return false;
  if (type.includes("BLOB") || type.length === 0) return false;
  return type.includes("NUMERIC") || type.includes("DECIMAL");
}

function assertWritableTable(table: string): void {
  for (const prefix of PROTECTED_PREFIXES) {
    if (table.toLowerCase().startsWith(prefix)) {
      throw new CliError(
        `Table "${table}" is in the protected namespace "${prefix}*" — platform-owned tables cannot be written.`,
      );
    }
  }
}

/** Reads a table's columns, proving the table exists before its name is used. */
function describeTable(db: Database, table: string): TableInfo {
  const exists = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table);
  if (!exists) {
    const available = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
      .filter((name) => !PROTECTED_PREFIXES.some((p) => name.startsWith(p)));
    throw new CliError(
      `Table "${table}" does not exist. Available: ${available.join(", ") || "none"}.`,
    );
  }
  // Safe to interpolate: the name came back from sqlite_master, not the caller.
  const columns = db.query<Column, []>(`PRAGMA table_info(${quoteIdent(exists.name)})`).all();
  return { name: exists.name, columns };
}

function columnOf(table: TableInfo, name: string): Column {
  const column = table.columns.find((candidate) => candidate.name === name);
  if (!column) {
    throw new CliError(
      `Table "${table.name}" has no column "${name}". ` +
        `Columns: ${table.columns.map((c) => c.name).join(", ")}.`,
    );
  }
  return column;
}

/**
 * Converts a value to what the column can hold, refusing anything SQLite would
 * otherwise store in a shape nobody asked for. `context` names the source of
 * the value for the error message.
 */
function coerce(value: unknown, column: Column, context: string): Binding {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") {
    throw new CliError(
      `${context}: "${column.name}" received ${Array.isArray(value) ? "an array" : "an object"}; ` +
        `only strings, numbers, booleans and null can be stored.`,
    );
  }

  const numeric = isNumericAffinity(column.type);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CliError(`${context}: "${column.name}" received ${value}, which cannot be stored.`);
    }
    return numeric ? value : String(value);
  }

  const text = value as string;
  if (!numeric) return text;
  if (text.trim().length === 0 || !Number.isFinite(Number(text))) {
    throw new CliError(
      `${context}: "${column.name}" is ${column.type} but received "${text}", which is not a number. ` +
        `Convert it first — SQLite would otherwise store the text and every later sum over it would be wrong.`,
    );
  }
  const parsed = Number(text);
  if (column.type.toUpperCase().includes("INT") && !Number.isInteger(parsed)) {
    throw new CliError(
      `${context}: "${column.name}" is ${column.type} but received "${text}", which is not an integer.`,
    );
  }
  return parsed;
}

/** Builds the WHERE clause and its bindings from structured filters. */
function compileFilters(
  filters: Filter[],
  table: TableInfo,
): { clause: string; bindings: Binding[] } {
  const parts: string[] = [];
  const bindings: Binding[] = [];
  for (const filter of filters) {
    const column = columnOf(table, filter.column);
    const ident = quoteIdent(column.name);

    if (filter.value === null) {
      // Only equality can test null; "contains null" has no meaning and used to
      // quietly become IS NULL, changing the operator the caller asked for.
      if (filter.operator !== "=" && filter.operator !== "!=") {
        throw new CliError(
          `--where: "${column.name}" cannot use "${filter.operator}" with ${NULL_TOKEN}; use = or !=.`,
        );
      }
      parts.push(filter.operator === "!=" ? `${ident} IS NOT NULL` : `${ident} IS NULL`);
      continue;
    }
    if (filter.operator === "~") {
      // instr() rather than LIKE: "contains" should mean contains, without the
      // caller's % and _ turning into wildcards.
      parts.push(`instr(${ident}, ?) > 0`);
      bindings.push(String(filter.value));
      continue;
    }
    parts.push(`${ident} ${filter.operator} ?`);
    bindings.push(coerce(filter.value, column, "--where"));
  }
  return { clause: parts.join(" AND "), bindings };
}

interface MatchedSet {
  rows: Record<string, unknown>[];
  receipt: string;
}

/**
 * The rows a filter matches, and a receipt identifying that exact set.
 *
 * A preview that cannot bind its apply is worse than none: it reports a safe
 * count, the data moves, and the apply hits a different set with the caller's
 * confidence already granted. The receipt closes that window the way
 * `publish --expect-version` closes it for application versions, so it covers
 * the intent as well as the rows — a preview of `price=1` cannot be redeemed
 * against `price=0` over the same set.
 *
 * Row order is not part of the identity. SQLite may return the same set in a
 * different order once an index or ANALYZE changes the plan, and that must not
 * read as "the data changed".
 */
function matchedSet(
  db: Database,
  table: TableInfo,
  clause: string,
  bindings: Binding[],
  intent: string,
): MatchedSet {
  const select = `SELECT * FROM ${quoteIdent(table.name)}${clause ? ` WHERE ${clause}` : ""}`;
  const rows = db.query<Record<string, unknown>, Binding[]>(select).all(...bindings);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(intent);
  for (const line of rows.map((row) => JSON.stringify(row)).sort()) hasher.update(line);
  return { rows, receipt: hasher.digest("hex").slice(0, 16) };
}

/**
 * Platform-owned, and created the same way the migration ledger is: lazily and
 * idempotently, so a workspace made before this table existed gains it on first
 * write rather than needing a migration it cannot be given.
 */
function ensureAudit(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
      id         INTEGER PRIMARY KEY,
      table_name TEXT NOT NULL,
      operation  TEXT NOT NULL,
      affected   INTEGER NOT NULL,
      receipt    TEXT,
      details    TEXT,
      before     TEXT,
      at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

function recordAudit(
  db: Database,
  table: string,
  operation: Operation,
  affected: number,
  receipt: string | null,
  details: unknown,
  before: Record<string, unknown>[] | null,
): void {
  const image =
    before === null
      ? null
      : JSON.stringify({
          rows: before.slice(0, AUDIT_IMAGE_LIMIT),
          truncated: before.length > AUDIT_IMAGE_LIMIT,
        });
  db.prepare<unknown, (string | number | null)[]>(
    `INSERT INTO ${AUDIT_TABLE} (table_name, operation, affected, receipt, details, before)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(table, operation, affected, receipt, JSON.stringify(details), image);
}

/**
 * Driver failures — a constraint violation, or SQLITE_BUSY when another writer
 * holds the lock — would otherwise reach the user as a bun:sqlite stack trace.
 */
function asCliError(error: unknown, what: string): CliError {
  if (error instanceof CliError) return error;
  return new CliError(`${what} failed: ${(error as Error).message}`);
}

export interface InsertOptions {
  table: string;
  rows: Record<string, unknown>[];
  /**
   * Return each row as stored. A generated key — a UUID default, an autoincrement
   * — is otherwise unknowable to the caller that just created it, and with a
   * random default there is nothing to query back by. Off unless asked, so a
   * bulk load does not hold the whole batch a second time.
   */
  returning?: boolean;
}

/**
 * Inserts rows. Unlike update and delete this applies directly: an insert can
 * only add, so its blast radius is the batch the caller already holds.
 *
 * Every row is validated before the first one is written, so a bad value at
 * row 400 leaves nothing behind rather than half a file.
 */
export function insertRows(ws: Workspace, options: InsertOptions): MutationResult {
  assertWritableTable(options.table);
  if (options.rows.length === 0) throw new CliError("No rows to insert.");

  const db = open(ws.dbPath);
  try {
    const table = describeTable(db, options.table);

    const prepared = options.rows.map((row, i) => {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new CliError(`Row ${i + 1} must be a JSON object.`);
      }
      const names = Object.keys(row);
      if (names.length === 0) throw new CliError(`Row ${i + 1} has no columns.`);
      const values: Record<string, Binding> = {};
      for (const name of names) {
        values[name] = coerce(row[name], columnOf(table, name), `Row ${i + 1}`);
      }
      return values;
    });

    ensureAudit(db);
    let affected = 0;
    const stored: Record<string, unknown>[] = [];
    db.transaction(() => {
      for (const row of prepared) {
        const names = Object.keys(row);
        const sql =
          `INSERT INTO ${quoteIdent(table.name)} (${names.map(quoteIdent).join(", ")}) ` +
          `VALUES (${names.map(() => "?").join(", ")})` +
          (options.returning ? " RETURNING *" : "");
        const statement = db.prepare<Record<string, unknown>, Binding[]>(sql);
        const bindings = names.map((name) => row[name]!);
        if (options.returning) {
          stored.push(...statement.all(...bindings));
        } else {
          statement.run(...bindings);
        }
        affected += 1;
      }
      recordAudit(db, table.name, "insert", affected, null, { rows: affected }, null);
    }).immediate();

    return {
      operation: "insert",
      table: table.name,
      affected,
      applied: true,
      ...(options.returning ? { rows: stored } : {}),
    };
  } catch (error) {
    throw asCliError(error, "Insert");
  } finally {
    db.close();
  }
}

export interface ChangeOptions {
  table: string;
  filters: Filter[];
  /** Column/value pairs for an update; absent for a delete. */
  set?: Record<string, unknown>;
  /** The receipt from a preview. Absent means preview only. */
  apply?: string;
  force?: boolean;
}

/**
 * Updates or deletes rows, previewing unless a matching receipt is presented.
 *
 * Preview is the default because these are the operations that destroy. The
 * extra step is not there to deter — a caller will pass the flag — but to put
 * the affected count in front of it, and to make the cap meaningful.
 */
export function changeRows(ws: Workspace, options: ChangeOptions): MutationResult {
  assertWritableTable(options.table);
  const operation: Operation = options.set ? "update" : "delete";
  if (options.filters.length === 0) {
    throw new CliError(
      `An unbounded ${operation} would ${operation === "delete" ? "empty" : "rewrite"} ` +
        `"${options.table}". Narrow it with --where <column><op><value>.`,
    );
  }

  const db = open(ws.dbPath);
  try {
    const table = describeTable(db, options.table);
    const { clause, bindings } = compileFilters(options.filters, table);

    const assignments: { column: Column; value: Binding }[] = [];
    for (const [name, value] of Object.entries(options.set ?? {})) {
      const column = columnOf(table, name);
      assignments.push({ column, value: coerce(value, column, "--set") });
    }
    if (operation === "update" && assignments.length === 0) {
      throw new CliError("An update needs at least one --set <column>=<value>.");
    }

    const intent = JSON.stringify({
      operation,
      table: table.name,
      clause,
      bindings,
      set: assignments.map((a) => [a.column.name, a.value]),
    });

    if (!options.apply) {
      const { rows, receipt } = matchedSet(db, table, clause, bindings, intent);
      return { operation, table: table.name, affected: rows.length, receipt, applied: false };
    }

    ensureAudit(db);

    // The match, the gates and the write share one immediate transaction, so
    // the write lock is held from the moment the set is identified. Checking
    // outside it would only narrow the window the receipt exists to close.
    const applied = db.transaction((): MutationResult => {
      const { rows, receipt } = matchedSet(db, table, clause, bindings, intent);
      if (options.apply !== receipt) {
        throw new CliError(
          `The rows matching this ${operation} changed since the preview ` +
            `(receipt ${options.apply}, now ${receipt}). Re-run the preview and apply that receipt.`,
        );
      }
      if (rows.length > MAX_AFFECTED_ROWS && !options.force) {
        throw new CliError(
          `This ${operation} affects ${rows.length} rows, beyond the ${MAX_AFFECTED_ROWS} row cap. ` +
            `Narrow the filter, or pass --force if that is genuinely the intent.`,
        );
      }

      if (operation === "delete") {
        db.prepare<unknown, Binding[]>(
          `DELETE FROM ${quoteIdent(table.name)} WHERE ${clause}`,
        ).run(...bindings);
      } else {
        const assign = assignments.map((a) => `${quoteIdent(a.column.name)} = ?`).join(", ");
        db.prepare<unknown, Binding[]>(
          `UPDATE ${quoteIdent(table.name)} SET ${assign} WHERE ${clause}`,
        ).run(...assignments.map((a) => a.value), ...bindings);
      }
      // The before-image is what makes a delete recoverable; without it the
      // audit records that rows went, not what they were.
      recordAudit(db, table.name, operation, rows.length, receipt, {
        filters: options.filters,
        set: options.set ?? null,
      }, rows);

      return { operation, table: table.name, affected: rows.length, receipt, applied: true };
    }).immediate();

    return applied;
  } catch (error) {
    throw asCliError(error, operation === "delete" ? "Delete" : "Update");
  } finally {
    db.close();
  }
}
