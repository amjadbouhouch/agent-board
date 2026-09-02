import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  applyMigration,
  createWorkspace,
  forcePublishedSpec,
  newProject,
  runCli,
  startServer,
  validSpec,
  type Project,
  type RunningServer,
} from "./helpers.ts";

let project: Project;
let ws: string;
let server: RunningServer;

const SCHEMA = `
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT);
INSERT INTO users VALUES ('u1','Alice','pro'),('u2','Bob','free'),('u3','Carol','pro');
`;

beforeEach(async () => {
  project = await newProject();
  ws = await createWorkspace(project);
  await applyMigration(project, ws, "0001_users.sql", SCHEMA);
});

afterEach(async () => {
  await server?.stop();
  await project.cleanup();
});

/** Publishes a specification carrying the given saved queries. */
async function publish(queries: { name: string; sql: string }[], title = "Ops"): Promise<Record<string, unknown>> {
  const spec = validSpec(ws, title);
  spec.savedQueries = queries;
  (spec.pages as any)[0].components[0].source = { type: "saved_query", query: queries[0]!.name };
  await project.write("app.json", spec);
  const result = await runCli(project.dir, ["publish", ws, "app.json"]);
  if (result.code !== 0) throw new Error(`publish failed: ${result.stderr}`);
  return spec;
}

test("GET application serves the published specification", async () => {
  const spec = await publish([{ name: "users", sql: "SELECT name FROM users ORDER BY name" }]);
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/${ws}/application`);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual(spec);
});

test("an unknown workspace is a structured 404 rather than a server error", async () => {
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/nope/application`);

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: "workspace_not_found" });
});

test("GET application/versions lists the published history with reasons", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }], "First");
  await project.write("v2.json", { ...(await publish([{ name: "users", sql: "SELECT name FROM users" }], "Second")) });
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/${ws}/application/versions`);

  expect(response.status).toBe(200);
  const body = (await response.json()) as any;
  expect(body.current).toBe(2);
  expect(body.versions).toHaveLength(2);
  expect(body.versions[0]).toMatchObject({ version: 1, reason: "published via CLI" });
  expect(body.versions[1]).toMatchObject({ version: 2 });
  expect(body.versions[1].checksum).toMatch(/^[0-9a-f]{64}$/);
});

test("POST queries/:name runs the published saved query", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users ORDER BY name" }]);
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/${ws}/queries/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    columns: ["name"],
    rows: [{ name: "Alice" }, { name: "Bob" }, { name: "Carol" }],
    rowCount: 3,
    truncated: false,
    limit: 100,
  });
});

test("POST queries binds parameters and honours a limit from the body", async () => {
  await publish([
    { name: "by_plan", sql: "SELECT name FROM users WHERE plan = $plan ORDER BY name" },
  ]);
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/${ws}/queries/by_plan`, {
    method: "POST",
    body: JSON.stringify({ parameters: { plan: "pro" }, limit: 1 }),
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as any;
  expect(body.rows).toEqual([{ name: "Alice" }]);
  expect(body.truncated).toBe(true);
  expect(body.limit).toBe(1);
});

test("POST queries ignores SQL supplied by the caller", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users ORDER BY name" }]);
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/${ws}/queries/users`, {
    method: "POST",
    body: JSON.stringify({ sql: "SELECT plan FROM users" }),
  });

  expect(response.status).toBe(200);
  // The published statement ran, not the one in the request body.
  expect((await response.json()) as any).toMatchObject({ columns: ["name"] });
});

test("POST queries rejects a parameter the published statement does not declare", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/${ws}/queries/users`, {
    method: "POST",
    body: JSON.stringify({ parameters: { plan: "pro" } }),
  });

  expect(response.status).toBe(400);
  expect((await response.json()) as any).toMatchObject({ error: "invalid_parameters" });
});

test("POST an unpublished query name is a 404", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/${ws}/queries/secret`, {
    method: "POST",
    body: "{}",
  });

  expect(response.status).toBe(404);
  expect((await response.json()) as any).toMatchObject({ error: "query_not_found" });
});

test("the host authorize hook can deny a request", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project, { authorize: async () => false });

  const application = await fetch(`${server.url}/workspaces/${ws}/application`);
  const query = await fetch(`${server.url}/workspaces/${ws}/queries/users`, {
    method: "POST",
    body: "{}",
  });

  expect(application.status).toBe(403);
  expect(query.status).toBe(403);
  expect((await application.json()) as any).toMatchObject({ error: "forbidden" });
});

test("the host authorize hook receives the workspace and the action being attempted", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  const seen: { workspaceId: string; action: string }[] = [];
  server = await startServer(project, {
    authorize: async (context: any) => {
      seen.push({ workspaceId: context.workspaceId, action: context.action });
      return context.action !== "query:run";
    },
  });

  const application = await fetch(`${server.url}/workspaces/${ws}/application`);
  const query = await fetch(`${server.url}/workspaces/${ws}/queries/users`, {
    method: "POST",
    body: "{}",
  });

  expect(application.status).toBe(200);
  expect(query.status).toBe(403);
  expect(seen).toEqual([
    { workspaceId: ws, action: "application:read" },
    { workspaceId: ws, action: "query:run" },
  ]);
});

test("with no authorize hook the runtime denies nothing but still serves", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/${ws}/application`);

  expect(response.status).toBe(200);
});

/** Scans 400M rows before its first output row; ~6.7s unthrottled. */
const PATHOLOGICAL_SQL = `
WITH RECURSIVE s(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM s WHERE k < 20000)
SELECT COUNT(*) AS c FROM s a, s b`;

test(
  "a query that overruns the deadline is cut off and does not block other requests",
  async () => {
    const spec = validSpec(ws);
    spec.savedQueries = [
      { name: "runaway", sql: PATHOLOGICAL_SQL },
      { name: "users", sql: "SELECT name FROM users ORDER BY name" },
    ];
    await forcePublishedSpec(project, ws, spec);
    server = await startServer(project, { queryTimeoutMs: 300 } as any);

    const runaway = fetch(`${server.url}/workspaces/${ws}/queries/runaway`, {
      method: "POST",
      body: "{}",
    });

    // While the runaway query is still going, a normal request must be served.
    const started = Date.now();
    const healthy = await fetch(`${server.url}/workspaces/${ws}/queries/users`, {
      method: "POST",
      body: "{}",
    });
    const healthyMs = Date.now() - started;

    expect(healthy.status).toBe(200);
    expect((await healthy.json()) as any).toMatchObject({ rowCount: 3 });
    expect(healthyMs).toBeLessThan(3000);

    const response = await runaway;
    expect(response.status).toBe(504);
    expect((await response.json()) as any).toMatchObject({ error: "query_timeout" });
  },
  20_000,
);

test("a workspace id cannot escape the workspaces directory", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  // Percent-encoded traversal survives URL normalisation, so the runtime has
  // to reject it rather than relying on the path parser.
  const encoded = await fetch(`${server.url}/workspaces/%2e%2e%2f%2e%2e/application`);
  const nested = await fetch(`${server.url}/workspaces/${encodeURIComponent("../" + ws)}/application`);

  expect(encoded.status).toBe(400);
  expect((await encoded.json()) as any).toMatchObject({ error: "invalid_workspace_id" });
  expect(nested.status).toBe(400);
});
