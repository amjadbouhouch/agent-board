import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadConfig, workspacesRoot, CliError } from "../lib/config.ts";
import { openWorkspace } from "../lib/workspace.ts";
import { formatTable } from "../lib/queries.ts";
import {
  changeRows,
  insertRows,
  upsertRows,
  FILTER_OPERATORS,
  NULL_TOKEN,
  type Filter,
  type FilterOperator,
  type MutationResult,
} from "../lib/mutations.ts";

const USAGE = `Usage:
  agent-board rows insert <workspace> <table> --data <json> | --data-file <path>
                                              [--returning]
  agent-board rows upsert <workspace> <table> --data-file <path> --on-conflict <col>[,<col>]
                                              [--returning]
  agent-board rows update <workspace> <table> --set <col>=<value> --where <col><op><value>
  agent-board rows delete <workspace> <table> --where <col><op><value>

Operators for --where: ${FILTER_OPERATORS.join(" ")}  (~ means contains)
Use ${NULL_TOKEN} for SQL NULL; a bare "null" is the literal text.`;

/** Which flags each subcommand accepts, so a misplaced one is refused not ignored. */
const ACCEPTS: Record<string, string[]> = {
  insert: ["--data", "--data-file", "--returning", "--json"],
  upsert: ["--data", "--data-file", "--on-conflict", "--returning", "--json"],
  update: ["--set", "--where", "--apply", "--force", "--json"],
  delete: ["--where", "--apply", "--force", "--json"],
};

interface Options {
  positional: string[];
  data?: string;
  dataFile?: string;
  set: Record<string, unknown>;
  filters: Filter[];
  apply?: string;
  force: boolean;
  returning: boolean;
  conflict: string[];
  json: boolean;
  /** Every flag actually seen, so it can be checked against the subcommand. */
  seen: string[];
}

const valueOf = (raw: string): string | null => (raw === NULL_TOKEN ? null : raw);

/**
 * `name=value`, `price>=150`, `notes~a=b`.
 *
 * The operator is the one appearing *earliest*, longest first at that position.
 * Scanning by operator instead of by position would split `notes~a=b` on the
 * `=`, yielding a column named `notes~a`.
 */
function parseFilter(token: string): Filter {
  let best: { at: number; operator: FilterOperator } | undefined;
  for (const operator of FILTER_OPERATORS) {
    const at = token.indexOf(operator);
    if (at < 1) continue;
    if (!best || at < best.at || (at === best.at && operator.length > best.operator.length)) {
      best = { at, operator };
    }
  }
  if (!best) {
    throw new CliError(
      `--where must be <column><operator><value>, got "${token}". ` +
        `Operators: ${FILTER_OPERATORS.join(" ")}.`,
    );
  }
  return {
    column: token.slice(0, best.at),
    operator: best.operator,
    value: valueOf(token.slice(best.at + best.operator.length)),
  };
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    positional: [], set: {}, filters: [], force: false, returning: false, conflict: [],
    json: false, seen: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = (): string => {
      const value = args[++i];
      if (value === undefined) throw new CliError(`${arg} requires a value.`);
      return value;
    };
    if (arg.startsWith("--")) options.seen.push(arg);
    switch (arg) {
      case "--data": options.data = next(); break;
      case "--data-file": options.dataFile = next(); break;
      case "--apply": options.apply = next(); break;
      case "--force": options.force = true; break;
      case "--returning": options.returning = true; break;
      case "--on-conflict":
        options.conflict = next()
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
        break;
      case "--json": options.json = true; break;
      case "--where": options.filters.push(parseFilter(next())); break;
      case "--set": {
        const token = next();
        const at = token.indexOf("=");
        if (at < 1) throw new CliError(`--set must be <column>=<value>, got "${token}".`);
        options.set[token.slice(0, at)] = valueOf(token.slice(at + 1));
        break;
      }
      default:
        if (arg.startsWith("--")) throw new CliError(`Unknown option "${arg}".`);
        options.positional.push(arg);
    }
  }
  return options;
}

/**
 * A flag that does not apply to the subcommand is a mistake about what the
 * command will do — `--apply` on an insert reads as "write it", and silently
 * dropping it would confirm a belief that was never true.
 */
function assertFlagsApply(sub: string, options: Options): void {
  const accepted = ACCEPTS[sub]!;
  for (const flag of options.seen) {
    if (!accepted.includes(flag)) {
      throw new CliError(
        `"${flag}" does not apply to \`rows ${sub}\`. Accepted: ${accepted.join(", ")}.`,
      );
    }
  }
}

async function readRows(options: Options): Promise<Record<string, unknown>[]> {
  let text: string;
  if (options.dataFile) {
    if (!existsSync(options.dataFile)) throw new CliError(`File not found: ${options.dataFile}`);
    text = await readFile(options.dataFile, "utf8");
  } else if (options.data) {
    text = options.data;
  } else {
    throw new CliError("Supply rows with --data <json> or --data-file <path>.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const source = options.dataFile ?? "--data";
    throw new CliError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  return (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
}

function report(result: MutationResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const noun = result.affected === 1 ? "row" : "rows";
  if (result.applied) {
    const verb = {
      insert: "Inserted",
      upsert: "Upserted",
      update: "Updated",
      delete: "Deleted",
    }[result.operation];
    console.log(`${verb} ${result.affected} ${noun} in "${result.table}".`);
    if (result.rows?.length) {
      console.log();
      console.log(
        formatTable({
          columns: Object.keys(result.rows[0]!),
          rows: result.rows,
          truncated: false,
          limit: result.rows.length,
        }),
      );
    }
    return;
  }
  console.log(
    `Preview: ${result.affected} ${noun} in "${result.table}" would be ${result.operation}d.`,
  );
  console.log("Nothing was written. Re-run with --apply <receipt> to write it.");
  console.log(`receipt: ${result.receipt}`);
}

export async function cmdRows(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const [sub, id, table] = options.positional;
  if (!sub || !id || !table) throw new CliError(USAGE);
  if (!(sub in ACCEPTS)) throw new CliError(`Unknown rows subcommand "${sub}".\n\n${USAGE}`);
  assertFlagsApply(sub, options);

  const config = await loadConfig();
  const ws = openWorkspace(workspacesRoot(config), id);

  if (sub === "insert") {
    report(
      insertRows(ws, { table, rows: await readRows(options), returning: options.returning }),
      options.json,
    );
    return 0;
  }
  if (sub === "upsert") {
    report(
      upsertRows(ws, {
        table,
        rows: await readRows(options),
        conflict: options.conflict,
        returning: options.returning,
      }),
      options.json,
    );
    return 0;
  }
  report(
    changeRows(ws, {
      table,
      filters: options.filters,
      set: sub === "update" ? options.set : undefined,
      apply: options.apply,
      force: options.force,
    }),
    options.json,
  );
  return 0;
}
