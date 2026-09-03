import { fileURLToPath } from "node:url";
import type { QueryOptions, QueryResult } from "../lib/queries.ts";
import type { Workspace } from "../lib/workspace.ts";
import type { QueryJob } from "../commands/run-query.ts";
import { HttpError, badRequest } from "./errors.ts";

export const DEFAULT_QUERY_TIMEOUT_MS = 5_000;

/** The internal subcommand that executes a single query in a child process. */
export const RUN_QUERY_COMMAND = "__run-query";

/**
 * How to re-invoke ourselves. A compiled standalone executable is its own
 * interpreter and takes the subcommand directly; otherwise the CLI entry point
 * is passed to the runtime.
 *
 * Detection uses `Bun.isStandaloneExecutable`. Do not infer this from
 * `import.meta.url`: under `--bytecode` it reports the original source path
 * from the *build* machine, a path that does not exist at runtime, which
 * silently selects the wrong branch and breaks every query in the binary.
 *
 * In development the entry is resolved relative to this module rather than from
 * `Bun.main`, because the runtime is also embedded by host applications and by
 * tests, where the main script is something else entirely.
 */
function selfCommand(): string[] {
  if (Bun.isStandaloneExecutable) {
    return [process.execPath, RUN_QUERY_COMMAND];
  }
  return [process.execPath, fileURLToPath(new URL("../cli.ts", import.meta.url)), RUN_QUERY_COMMAND];
}

/**
 * Runs a query in a child process and kills it if the deadline passes. The
 * child is single-use: it is the unit of cancellation, since a running SQLite
 * statement cannot otherwise be aborted, and its separate address space keeps
 * a runaway query from taking the server down with it.
 */
export async function executeWithDeadline(
  workspace: Workspace,
  sql: string,
  options: QueryOptions,
  timeoutMs: number,
): Promise<QueryResult> {
  const job: QueryJob = { workspace, sql, options };
  const child = Bun.spawn(selfCommand(), {
    stdin: new TextEncoder().encode(JSON.stringify(job)),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => child.kill(), timeoutMs);
  let stdout: string;
  let exitCode: number;
  try {
    [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  } finally {
    clearTimeout(timer);
  }

  if (child.killed && stdout.trim().length === 0) {
    throw new HttpError(
      504,
      "query_timeout",
      `Query exceeded the ${timeoutMs}ms execution deadline and was cancelled.`,
    );
  }

  let message: { ok?: boolean; kind?: string; message?: string; result?: QueryResult };
  try {
    message = JSON.parse(stdout);
  } catch {
    const stderr = await new Response(child.stderr).text();
    throw new HttpError(
      500,
      "query_failed",
      `Query process exited with code ${exitCode}: ${stderr.trim() || "no output"}`,
    );
  }

  if (message.ok && message.result) return message.result;
  if (message.kind === "parameter") {
    throw badRequest("invalid_parameters", String(message.message));
  }
  // Naming a column the result does not have is the caller's mistake, not a
  // broken query, so it gets a 400 with its own code rather than an opaque 500.
  if (message.kind === "sort") {
    throw badRequest("invalid_sort", String(message.message));
  }
  throw new HttpError(500, "query_failed", String(message.message ?? "Query failed."));
}
