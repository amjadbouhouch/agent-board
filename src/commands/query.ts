import { loadConfig, workspacesRoot, CliError } from "../lib/config.ts";
import { openWorkspace, type Workspace } from "../lib/workspace.ts";
import { readCurrentApplication } from "../lib/application.ts";
import {
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
  formatTable,
  runQuery,
  savedQueriesOf,
} from "../lib/queries.ts";

async function resolveSavedQuery(ws: Workspace, name: string): Promise<string> {
  const spec = await readCurrentApplication(ws);
  const queries = savedQueriesOf(spec);
  const query = queries.find((q) => q.name === name);
  if (!query) {
    const available = queries.map((q) => q.name).join(", ") || "none";
    throw new CliError(`Saved query "${name}" not found. Available: ${available}.`);
  }
  return query.sql;
}

export async function cmdQuery(args: string[]): Promise<number> {
  const positional: string[] = [];
  let saved: string | undefined;
  let limit = DEFAULT_ROW_LIMIT;
  const parameters: Record<string, string> = {};
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--saved") {
      const raw = args[++i];
      if (raw === undefined) throw new CliError("--saved requires a query name.");
      saved = raw;
    } else if (arg === "--limit") {
      const raw = args[++i];
      limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new CliError(`--limit must be a positive integer, got "${raw}".`);
      }
      // Erroring rather than clamping: a silently capped result looks complete.
      if (limit > MAX_ROW_LIMIT) {
        throw new CliError(`--limit may not exceed ${MAX_ROW_LIMIT}, got ${limit}.`);
      }
    } else if (arg === "--param") {
      const raw = args[++i];
      if (raw === undefined) throw new CliError("--param requires name=value.");
      const eq = raw.indexOf("=");
      if (eq < 1) throw new CliError(`--param must be name=value, got "${raw}".`);
      parameters[raw.slice(0, eq)] = raw.slice(eq + 1);
    } else if (arg === "--json") {
      asJson = true;
    } else if (arg.startsWith("--")) {
      throw new CliError(`Unknown option "${arg}".`);
    } else {
      positional.push(arg);
    }
  }

  const [id, inlineSql] = positional;
  if (!id || (!saved && !inlineSql)) {
    throw new CliError(
      'Usage: agent-board query <workspace> (--saved <name> | "<sql>") ' +
        '[--param <name>=<value>]... [--limit <n>] [--json]',
    );
  }
  if (saved && inlineSql) {
    throw new CliError("Pass either --saved <name> or inline SQL, not both.");
  }

  const config = await loadConfig();
  const ws = openWorkspace(workspacesRoot(config), id);
  const sql = saved ? await resolveSavedQuery(ws, saved) : inlineSql!;

  const result = runQuery(ws, sql, { limit, parameters });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rows.length,
          truncated: result.truncated,
          limit: result.limit,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const table = formatTable(result);
  if (table) console.log(table);

  const count = `${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`;
  const note = result.truncated ? ` (truncated at --limit ${result.limit})` : "";
  console.log(`\n${count}${note}`);
  return 0;
}
