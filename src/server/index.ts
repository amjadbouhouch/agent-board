import { existsSync } from "node:fs";
import { readMetadata, workspacePaths, type Workspace } from "../lib/workspace.ts";
import { listApplicationVersionRecords, readCurrentApplication } from "../lib/application.ts";
import { MAX_ROW_LIMIT, savedQueriesOf } from "../lib/queries.ts";
import { DEFAULT_QUERY_TIMEOUT_MS, executeWithDeadline } from "./execute.ts";
import { HttpError, badRequest, forbidden, notFound, payloadTooLarge } from "./errors.ts";

/** Actions the runtime asks the host to authorize. */
export type Action = "application:read" | "query:run";

export interface AuthorizeContext {
  request: Request;
  workspaceId: string;
  action: Action;
}

export interface AgentBoardOptions {
  /** Directory holding one subdirectory per workspace. */
  workspacesDir: string;
  /**
   * Host-owned authorization. Authentication and the hard
   * permission ceiling belong to the host application, never to a published
   * specification. Omitting this serves every workspace in `workspacesDir`
   * without restriction, which is only appropriate for local development.
   */
  authorize?(context: AuthorizeContext): boolean | Promise<boolean>;
  /** Per-query execution deadline in milliseconds. */
  queryTimeoutMs?: number;
}

export interface AgentBoard {
  fetch(request: Request): Promise<Response>;
}

/**
 * One generic backend serving every published application. It never generates
 * or evaluates per-workspace code — it reads validated definitions and executes
 * saved queries.
 */
export function createAgentBoard(options: AgentBoardOptions): AgentBoard {
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        return await route(options, request);
      } catch (error) {
        if (error instanceof HttpError) return error.toResponse();
        // Nothing internal reaches the client: log it, return an opaque 500.
        console.error("agent-board:", error);
        return Response.json(
          { error: "internal_error", message: "The runtime failed to handle this request." },
          { status: 500 },
        );
      }
    },
  };
}

async function authorizeOrThrow(
  options: AgentBoardOptions,
  context: AuthorizeContext,
): Promise<void> {
  if (!options.authorize) return;
  const allowed = await options.authorize(context);
  if (!allowed) {
    throw forbidden(`Not permitted to ${context.action} on workspace "${context.workspaceId}".`);
  }
}

/**
 * Workspace ids are the slugs `workspace create` produces. Validating against
 * that shape — rather than trusting URL normalisation or sanitising after the
 * fact — is what keeps a request from addressing anything outside the
 * workspaces directory.
 */
const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Resolves a workspace, or fails with a 404 the caller can act on. */
function requireWorkspace(options: AgentBoardOptions, id: string): Workspace {
  if (!WORKSPACE_ID.test(id)) {
    throw badRequest("invalid_workspace_id", `"${id}" is not a valid workspace id.`);
  }
  const ws = workspacePaths(options.workspacesDir, id);
  if (!existsSync(ws.metadataPath)) {
    throw notFound("workspace_not_found", `Workspace "${id}" does not exist.`);
  }
  return ws;
}

async function route(options: AgentBoardOptions, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] === "workspaces" && segments.length >= 3) {
    const workspaceId = segments[1]!;
    const [, , resource, child] = segments;
    if (!WORKSPACE_ID.test(workspaceId)) {
      throw badRequest("invalid_workspace_id", `"${workspaceId}" is not a valid workspace id.`);
    }

    // Authorized before the workspace is even resolved, so a denied caller
    // cannot probe which workspaces exist.
    const action: Action | undefined =
      resource === "application" ? "application:read" : resource === "queries" ? "query:run" : undefined;
    if (action) await authorizeOrThrow(options, { request, workspaceId, action });

    const ws = requireWorkspace(options, workspaceId);

    if (resource === "application" && request.method === "GET") {
      if (segments.length === 3) {
        return Response.json(await readCurrentApplication(ws));
      }
      if (child === "versions" && segments.length === 4) {
        const [metadata, versions] = await Promise.all([
          readMetadata(ws),
          listApplicationVersionRecords(ws),
        ]);
        return Response.json({ current: metadata.appVersion, versions });
      }
    }

    if (resource === "queries" && segments.length === 4 && request.method === "POST") {
      return runSavedQuery(options, ws, child!, request);
    }
  }

  throw notFound("not_found", `No route for ${request.method} ${url.pathname}.`);
}

interface QueryRequestBody {
  parameters: Record<string, string | null>;
  limit?: number;
  offset?: number;
  sort?: string[];
}

/**
 * A query request carries only parameters and a limit, so anything approaching
 * this size is a mistake or an attack. Both are rejected before the body is
 * held in memory.
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Reads the body while counting bytes. `Content-Length` is checked first as a
 * cheap rejection, but it is caller-supplied and absent on chunked requests, so
 * the running total is what actually enforces the cap.
 */
async function readBodyText(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw payloadTooLarge(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw payloadTooLarge(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Values SQLite can bind. Anything else is the caller's mistake, not a 500. */
function validateParameters(value: unknown): Record<string, string | null> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("invalid_parameters", "parameters must be a JSON object.");
  }
  const parameters: Record<string, string | null> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw === "string") {
      parameters[name] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      parameters[name] = String(raw);
    } else {
      throw badRequest(
        "invalid_parameters",
        `Parameter "${name}" must be a string, number, boolean or null.`,
      );
    }
  }
  return parameters;
}

function validateLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw badRequest("invalid_limit", `limit must be an integer from 1 to ${MAX_ROW_LIMIT}.`);
  }
  if (value > MAX_ROW_LIMIT) {
    throw badRequest("invalid_limit", `limit may not exceed ${MAX_ROW_LIMIT}, got ${value}.`);
  }
  return value;
}

function validateOffset(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw badRequest("invalid_offset", "offset must be a whole count of rows to skip.");
  }
  return value;
}

/**
 * Shape only — whether a column exists is decided by the query that runs, so
 * that check happens there and comes back as `invalid_sort` too.
 */
function validateSort(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest("invalid_sort", "sort must be a non-empty array of column names.");
  }
  return value.map((entry) => {
    const name = typeof entry === "string" && entry.startsWith("-") ? entry.slice(1) : entry;
    if (typeof name !== "string" || name.length === 0) {
      throw badRequest(
        "invalid_sort",
        'sort entries must name a column, "-column" for descending.',
      );
    }
    return entry as string;
  });
}

async function readJsonBody(request: Request): Promise<QueryRequestBody> {
  const text = await readBodyText(request);
  if (text.trim().length === 0) return { parameters: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("invalid_body", "Request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("invalid_body", "Request body must be a JSON object.");
  }

  const body = parsed as Record<string, unknown>;
  return {
    parameters: validateParameters(body.parameters),
    limit: validateLimit(body.limit),
    offset: validateOffset(body.offset),
    sort: validateSort(body.sort),
  };
}

/**
 * Executes a query by name from the published specification. Callers supply
 * parameters, never SQL — the statement text is only ever read from the
 * validated application definition.
 */
async function runSavedQuery(
  options: AgentBoardOptions,
  ws: Workspace,
  name: string,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request);
  const spec = await readCurrentApplication(ws);
  const query = savedQueriesOf(spec).find((candidate) => candidate.name === name);
  if (!query) {
    throw notFound("query_not_found", `Saved query "${name}" is not published.`);
  }

  const result = await executeWithDeadline(
    ws,
    query.sql,
    { parameters: body.parameters, limit: body.limit, offset: body.offset, sort: body.sort },
    options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
  );
  return Response.json({
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rows.length,
    truncated: result.truncated,
    limit: result.limit,
  });
}
