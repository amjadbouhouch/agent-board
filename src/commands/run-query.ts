import { ParameterError, runQuery, type QueryOptions } from "../lib/queries.ts";
import type { Workspace } from "../lib/workspace.ts";

export interface QueryJob {
  workspace: Workspace;
  sql: string;
  options: QueryOptions;
}

/**
 * Internal: executes one query and exits. The server spawns this rather than
 * running queries on its own thread, because bun:sqlite cannot interrupt a
 * running statement and SQLite work is synchronous — one expensive query would
 * otherwise stall every other request. Killing the process is the unit of
 * cancellation.
 *
 * The job arrives on stdin; it never accepts SQL from a network caller, only
 * whatever the runtime read out of the published specification.
 */
export async function cmdRunQuery(): Promise<number> {
  const job: QueryJob = JSON.parse(await new Response(Bun.stdin.stream()).text());
  try {
    const result = runQuery(job.workspace, job.sql, job.options);
    console.log(JSON.stringify({ ok: true, result }));
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        kind: error instanceof ParameterError ? "parameter" : "query",
        message: (error as Error).message,
      }),
    );
  }
  return 0;
}
