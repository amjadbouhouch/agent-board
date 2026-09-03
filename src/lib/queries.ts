import { open } from "./db.ts";
import { CliError } from "./config.ts";

/** A caller-supplied parameter problem, as opposed to a broken query. */
export class ParameterError extends CliError {}
import type { Workspace } from "./workspace.ts";

export interface SavedQuery {
  name: string;
  sql: string;
}

/** Reads the savedQueries array out of an application specification. */
export function savedQueriesOf(spec: unknown): SavedQuery[] {
  const queries = (spec as { savedQueries?: unknown })?.savedQueries;
  if (!Array.isArray(queries)) return [];
  return queries.filter(
    (q): q is SavedQuery => typeof q?.name === "string" && typeof q?.sql === "string",
  );
}

const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|CREATE|ALTER|ATTACH|DETACH|VACUUM|PRAGMA|REINDEX|BEGIN|COMMIT|ROLLBACK)\b/i;

/**
 * Blanks out comments and quoted text so keyword and statement-separator
 * checks cannot be fooled by a literal such as 'delete' or ';'.
 */
function normalizeForScan(sql: string): string {
  return sql
   .replace(/--[^\n]*/g, " ")
   .replace(/\/\*[\s\S]*?\*\//g, " ")
   .replace(/'(?:''|[^'])*'/g, "''")
   .replace(/"(?:""|[^"])*"/g, '""')
   .trim();
}

/**
 * Dashboard saved queries must be a single read-only statement.
 * bun:sqlite exposes no statement-level readonly flag, so this is the strong
 * allowlist this uses instead.
 */
export function readOnlyViolation(sql: string): string | null {
  const scan = normalizeForScan(sql).replace(/;\s*$/, "");
  if (scan.length === 0) return "must not be empty";
  if (scan.includes(";")) {
    return "must be read-only — it must be a single statement";
  }
  if (!/^(SELECT|WITH)\b/i.test(scan)) {
    return "must be read-only — it must start with SELECT or WITH";
  }
  const write = scan.match(WRITE_KEYWORDS);
  if (write) {
    return `must be read-only — "${write[1]!.toUpperCase()}" is not allowed`;
  }
  return null;
}

/**
 * Runs every saved query against the workspace database, capped at one row, so
 * a specification whose queries reference missing tables, mutate data, or fail
 * only at execution time cannot be published.
 * Declared parameters are bound to NULL — the goal is proving the statement
 * executes, not checking any particular filter value.
 */
export function smokeTestSavedQueries(ws: Workspace, spec: unknown): string[] {
  const errors: string[] = [];
  for (const query of savedQueriesOf(spec)) {
    const parameters = Object.fromEntries(
      [...declaredParameters(query.sql).keys()].map((name) => [name, null]),
    );
    try {
      runQuery(ws, query.sql, { limit: 1, parameters });
    } catch (error) {
      errors.push(`saved query "${query.name}": ${(error as Error).message}`);
    }
  }
  return errors;
}

/** Default cap on returned rows. */
export const DEFAULT_ROW_LIMIT = 100;

/**
 * Hard ceiling on returned rows. Entry points validate and report a clear error
 * before reaching this, but the clamp lives here so no caller — present or
 * future — can raise the cap by passing a larger or wrongly typed value.
 */
export const MAX_ROW_LIMIT = 10_000;

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** True when the row limit stopped the result short of the full set. */
  truncated: boolean;
  limit: number;
}

export interface QueryOptions {
  limit?: number;
  parameters?: Record<string, string | null>;
}

/**
 * Runs a read-only statement and returns its rows. The allowlist gives a clear
 * error up front; `PRAGMA query_only` is the backstop that makes the connection
 * itself incapable of writing.
 */
export function runQuery(ws: Workspace, sql: string, options: QueryOptions = {}): QueryResult {
  const violation = readOnlyViolation(sql);
  if (violation) throw new CliError(`Query ${violation}.`);

  // A non-integer limit used to make the `rows.length >= limit` guard always
  // false, disabling the cap entirely, so anything unusable falls back.
  const requested = options.limit;
  const limit =
    typeof requested === "number" && Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_ROW_LIMIT)
      : DEFAULT_ROW_LIMIT;
  const db = open(ws.dbPath, { readOnly: true });
  try {
    const statement = db.query(sql);
    const columns = statement.columnNames;
    const bindings = bindParameters(sql, options.parameters ?? {});

    // Streamed rather than collected with.all(), so an enormous result set is
    // never fully materialised just to be thrown away.
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    for (const row of statement.iterate(bindings) as Iterable<Record<string, unknown>>) {
      if (rows.length >= limit) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    statement.finalize();
    return { columns, rows, truncated, limit };
  } catch (error) {
    // A missing table or a syntax error arrives as a driver exception, which
    // would otherwise reach the user as a stack trace through bun:sqlite.
    if (error instanceof CliError) throw error;
    throw new CliError(`Query failed: ${(error as Error).message}`);
  } finally {
    db.close();
  }
}

/**
 * Placeholder names declared by the statement, mapped to the exact token used
 * ($name, :name or @name). Comments and quoted text are blanked first so a
 * literal like '$5' is not mistaken for a parameter.
 */
export function declaredParameters(sql: string): Map<string, string> {
  const declared = new Map<string, string>();
  const scan = normalizeForScan(sql);
  for (const match of scan.matchAll(/(?<![\w$:@])([$:@])([A-Za-z_][A-Za-z0-9_]*)/g)) {
    declared.set(match[2]!, match[1]! + match[2]!);
  }
  return declared;
}

/**
 * Maps supplied names onto the statement's declared placeholders. Values are
 * always bound, never interpolated. bun:sqlite silently binds NULL for a name
 * the statement never declared, which would quietly return the wrong rows, so
 * both unknown and missing names are hard errors here.
 */
function bindParameters(
  sql: string,
  parameters: Record<string, string | null>,
): Record<string, string | null> {
  const declared = declaredParameters(sql);
  const supplied = Object.keys(parameters);

  const unknown = supplied.filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    const names = [...declared.keys()].join(", ") || "none";
    throw new ParameterError(
      `Query does not declare parameter(s): ${unknown.join(", ")}. Declared: ${names}.`,
    );
  }
  const missing = [...declared.keys()].filter((name) => !(name in parameters));
  if (missing.length > 0) {
    throw new ParameterError(
      `Missing value for parameter(s): ${missing.join(", ")}. Supply every declared parameter.`,
    );
  }

  return Object.fromEntries(supplied.map((name) => [declared.get(name)!, parameters[name]!]));
}

/** Renders rows as an aligned text table. */
export function formatTable(result: QueryResult): string {
  const { columns, rows } = result;
  if (columns.length === 0) return "";
  const cell = (value: unknown) => (value === null || value === undefined ? "" : String(value));
  const widths = columns.map((column, i) =>
    Math.max(column.length, ...rows.map((row) => cell(row[columns[i]!]).length), 0),
  );
  const line = (values: string[]) =>
    values.map((value, i) => value.padEnd(widths[i]!)).join("  ").trimEnd();
  return [
    line(columns),
    line(widths.map((width) => "-".repeat(width))),
   ...rows.map((row) => line(columns.map((column) => cell(row[column])))),
  ].join("\n");
}
