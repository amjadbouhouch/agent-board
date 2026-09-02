import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readMetadata, workspacePaths, type Workspace } from "../lib/workspace.ts";
import { listApplicationVersionRecords } from "../lib/application.ts";
import { savedQueriesOf } from "../lib/queries.ts";
import { DEFAULT_QUERY_TIMEOUT_MS, executeWithDeadline } from "./execute.ts";
import { HttpError, badRequest, forbidden, notFound } from "./errors.ts";

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
        const body = await readFile(ws.applicationPath, "utf8");
        return new Response(body, {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
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
  parameters?: Record<string, string | null>;
  limit?: number;
}

async function readJsonBody(request: Request): Promise<QueryRequestBody> {
  const text = await request.text();
  if (text.trim().length === 0) return {};
  try {
    const body = JSON.parse(text);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw badRequest("invalid_body", "Request body must be a JSON object.");
    }
    return body as QueryRequestBody;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw badRequest("invalid_body", "Request body is not valid JSON.");
  }
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
  const spec = JSON.parse(await readFile(ws.applicationPath, "utf8"));
  const query = savedQueriesOf(spec).find((candidate) => candidate.name === name);
  if (!query) {
    throw notFound("query_not_found", `Saved query "${name}" is not published.`);
  }

  const result = await executeWithDeadline(
    ws,
    query.sql,
    { parameters: body.parameters ?? {}, limit: body.limit },
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
