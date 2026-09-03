import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * The row limit and the request body are both caller-controlled, so both are
 * bounded. A string limit used to pass straight through to a `>=` comparison
 * that is always false, which disabled the cap and returned the whole table.
 */
const BAD_LIMITS: [string, unknown][] = [
  ["a string", "abc"],
  ["negative", -5],
  ["zero", 0],
  ["fractional", 1.5],
  ["null", null],
  ["an object", { n: 1 }],
];

for (const [label, limit] of BAD_LIMITS) {
  test(`POST queries rejects ${label} as a limit`, async () => {
    await publish([{ name: "stores", sql: "SELECT name FROM users ORDER BY name" }]);
    server = await startServer(project);

    const response = await fetch(`${server.url}/workspaces/${ws}/queries/stores`, {
      method: "POST",
      body: JSON.stringify({ limit }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as any).toMatchObject({ error: "invalid_limit" });
  });
}

test("POST queries refuses a limit above the maximum instead of honouring it", async () => {
  await publish([{ name: "stores", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/${ws}/queries/stores`, {
    method: "POST",
    body: JSON.stringify({ limit: 5_000_000 }),
  });

  expect(response.status).toBe(400);
  const body = (await response.json()) as any;
  expect(body.error).toBe("invalid_limit");
  expect(body.message).toMatch(/\d/); // states the maximum
});

test("POST queries rejects an oversized request body", async () => {
  await publish([{ name: "stores", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/${ws}/queries/stores`, {
    method: "POST",
    body: JSON.stringify({ limit: 1, pad: "A".repeat(2_000_000) }),
  });

  expect(response.status).toBe(413);
  expect((await response.json()) as any).toMatchObject({ error: "body_too_large" });
});

test("POST queries rejects a parameter value that is not a scalar", async () => {
  await publish([
    { name: "by_plan", sql: "SELECT name FROM users WHERE plan = $plan" },
  ]);
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/${ws}/queries/by_plan`, {
    method: "POST",
    body: JSON.stringify({ parameters: { plan: { nested: true } } }),
  });

  // Previously a 500 leaking the driver's "Binding expected string, ..." text.
  expect(response.status).toBe(400);
  expect((await response.json()) as any).toMatchObject({ error: "invalid_parameters" });
});

test("POST queries rejects parameters that are not an object", async () => {
  await publish([{ name: "stores", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/${ws}/queries/stores`, {
    method: "POST",
    body: JSON.stringify({ parameters: ["a", "b"] }),
  });

  expect(response.status).toBe(400);
  expect((await response.json()) as any).toMatchObject({ error: "invalid_parameters" });
});

/**
 * Ordering and paging over HTTP. A renderer needs these per request — a table
 * cannot republish the specification because someone clicked a column header.
 */
async function post(name: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}/workspaces/${ws}/queries/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Posts and parses, since every assertion below reads named fields. */
async function postJson(name: string, body: unknown): Promise<any> {
  return (await post(name, body)).json();
}

test("POST accepts sort and offset, and pages without repeating a row", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  const first = await postJson("users", { sort: ["name"], limit: 2 });
  expect(first.rows).toEqual([{ name: "Alice" }, { name: "Bob" }]);
  expect(first.truncated).toBe(true);

  const second = await postJson("users", { sort: ["name"], limit: 2, offset: 2 });
  expect(second.rows).toEqual([{ name: "Carol" }]);
  expect(second.truncated).toBe(false);
});

test("POST sorts descending on a leading minus", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  const body = await postJson("users", { sort: ["-name"] });
  expect(body.rows).toEqual([{ name: "Carol" }, { name: "Bob" }, { name: "Alice" }]);
});

test("POST rejects a sort column the query does not return", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  // The caller named a column that is not in the result — their mistake, so a
  // 400 with its own code rather than an opaque 500.
  const response = await post("users", { sort: ["nope"] });
  expect(response.status).toBe(400);
  const body: any = await response.json();
  expect(body.error).toBe("invalid_sort");
  expect(body.message).toContain("name");
});

test("POST rejects a malformed sort or offset", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  for (const body of [{ sort: "name" }, { sort: [] }, { sort: [1] }, { sort: [""] }]) {
    const response = await post("users", body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error).toBe("invalid_sort");
  }
  for (const body of [{ offset: -1 }, { offset: 1.5 }, { offset: "2" }]) {
    const response = await post("users", body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error).toBe("invalid_offset");
  }
});

test("POST accepts a filter and narrows the result", async () => {
  await publish([{ name: "users", sql: "SELECT name, plan FROM users" }]);
  server = await startServer(project);

  const body = await postJson("users", {
    filter: [{ field: "plan", operator: "eq", value: "pro" }],
    sort: ["name"],
  });
  expect(body.rows).toEqual([
    { name: "Alice", plan: "pro" },
    { name: "Carol", plan: "pro" },
  ]);
});

test("POST rejects a filter field the query does not return", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  const response = await post("users", {
    filter: [{ field: "plan", operator: "eq", value: "pro" }],
  });
  expect(response.status).toBe(400);
  expect(((await response.json()) as any).error).toBe("invalid_filter");
});

test("POST rejects a malformed filter", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  const bad = [
    { filter: "name" },
    { filter: [] },
    { filter: [{ field: "name" }] },
    { filter: [{ field: "name", operator: "approximately", value: 1 }] },
    { filter: [{ field: "name", operator: "eq", value: { nested: true } }] },
  ];
  for (const body of bad) {
    const response = await post("users", body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error).toBe("invalid_filter");
  }
});

/**
 * Browser access. A page served from another origin cannot call this runtime
 * unless the host names that origin, and it never gets a wildcard: `start`
 * configures no authorize hook, so `*` would let any site the user visits read
 * every workspace on their machine.
 */
test("no CORS headers unless the host allows the origin", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project);

  const response = await fetch(`${server.url}/workspaces/${ws}/application`, {
    headers: { origin: "http://localhost:5173" },
  });
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

test("an allowed origin gets CORS headers and a preflight", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project, { allowedOrigins: ["http://localhost:5173"] });

  const preflight = await fetch(`${server.url}/workspaces/${ws}/queries/users`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");

  const query = await fetch(`${server.url}/workspaces/${ws}/queries/users`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({}),
  });
  expect(query.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  expect(query.headers.get("vary")).toBe("origin");
});

test("an origin outside the allowlist still gets nothing", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  server = await startServer(project, { allowedOrigins: ["http://localhost:5173"] });

  const response = await fetch(`${server.url}/workspaces/${ws}/application`, {
    headers: { origin: "http://evil.example" },
  });
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

test("--static serves a UI from the same origin, which needs no CORS at all", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  const dir = project.path("ui");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), "<!doctype html><title>Board</title>");
  await writeFile(join(dir, "app.js"), "export const ready = true;");
  server = await startServer(project, { staticDir: dir });

  expect(await (await fetch(`${server.url}/`)).text()).toContain("<title>Board</title>");
  expect(await (await fetch(`${server.url}/app.js`)).text()).toContain("ready");

  // API routes still win over a file of the same name.
  const api = await fetch(`${server.url}/workspaces/${ws}/application`);
  expect(api.status).toBe(200);
});

test("a static path cannot escape the directory it serves", async () => {
  await publish([{ name: "users", sql: "SELECT name FROM users" }]);
  const dir = project.path("ui");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), "ok");
  await writeFile(project.path("secret.txt"), "not for the web");
  server = await startServer(project, { staticDir: dir });

  for (const path of ["/../secret.txt", "/..%2Fsecret.txt", "/a/../../secret.txt"]) {
    const response = await fetch(`${server.url}${path}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("not for the web");
  }
});
