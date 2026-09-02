import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  applyMigration,
  createWorkspace,
  newProject,
  runCli,
  startCliServer,
  validSpec,
  type Project,
  type RunningServer,
} from "./helpers.ts";

let project: Project;
let ws: string;
let server: RunningServer | undefined;

beforeEach(async () => {
  project = await newProject();
  ws = await createWorkspace(project);
  await applyMigration(
    project,
    ws,
    "0001_users.sql",
    "CREATE TABLE users (name TEXT); INSERT INTO users VALUES ('Alice');",
  );
  const spec = validSpec(ws, "Ops");
  spec.savedQueries = [{ name: "users", sql: "SELECT name FROM users" }];
  (spec.pages as any)[0].components[0].source = { type: "saved_query", query: "users" };
  await project.write("app.json", spec);
  const published = await runCli(project.dir, ["publish", ws, "app.json"]);
  if (published.code !== 0) throw new Error(published.stderr);
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await project.cleanup();
});

/**
 * The defining promise: the agent's work keeps serving with no agent, no
 * sandbox and no generated per-workspace code — just the CLI and the files.
 */
test("start serves the published application and its saved queries", async () => {
  server = await startCliServer(project);

  const application = await fetch(`${server.url}/workspaces/${ws}/application`);
  expect(application.status).toBe(200);
  expect((await application.json()) as any).toMatchObject({ title: "Ops" });

  const query = await fetch(`${server.url}/workspaces/${ws}/queries/users`, {
    method: "POST",
    body: "{}",
  });
  expect(query.status).toBe(200);
  expect((await query.json()) as any).toMatchObject({ rows: [{ name: "Alice" }] });
});

/**
 * The agent creates the database and application, the agent stops, and the
 * application keeps working. The CLI stands in for the agent here — every CLI
 * process has exited by the time the runtime is asked for data.
 */
test("the application keeps working after every agent-side process has exited", async () => {
  // Nothing is running at this point: publish and migrate were separate
  // short-lived processes that have already exited.
  server = await startCliServer(project);

  const application = await fetch(`${server.url}/workspaces/${ws}/application`);
  const rows = await fetch(`${server.url}/workspaces/${ws}/queries/users`, {
    method: "POST",
    body: "{}",
  });
  expect(application.status).toBe(200);
  expect((await rows.json()) as any).toMatchObject({ rows: [{ name: "Alice" }] });

  // The agent comes back, changes the application, and leaves again — while the
  // runtime stays up. No restart, no redeploy.
  const spec = validSpec(ws, "Ops v2");
  spec.savedQueries = [{ name: "users", sql: "SELECT name AS customer FROM users" }];
  (spec.pages as any)[0].components[0].source = { type: "saved_query", query: "users" };
  await project.write("v2.json", spec);
  const republished = await runCli(project.dir, ["publish", ws, "v2.json", "--reason", "rename column"]);
  expect(republished.stderr).toBe("");

  const updated = await fetch(`${server.url}/workspaces/${ws}/application`);
  expect((await updated.json()) as any).toMatchObject({ title: "Ops v2" });
  const updatedRows = await fetch(`${server.url}/workspaces/${ws}/queries/users`, {
    method: "POST",
    body: "{}",
  });
  expect((await updatedRows.json()) as any).toMatchObject({ columns: ["customer"] });

  // And a rollback is visible to the running server too.
  const rolled = await runCli(project.dir, ["rollback", ws, "1"]);
  expect(rolled.stderr).toBe("");
  const restored = await fetch(`${server.url}/workspaces/${ws}/application`);
  expect((await restored.json()) as any).toMatchObject({ title: "Ops" });

  const versions = await fetch(`${server.url}/workspaces/${ws}/application/versions`);
  const history = (await versions.json()) as any;
  expect(history.current).toBe(3);
  expect(history.versions.map((v: any) => v.reason)).toEqual([
    "published via CLI",
    "rename column",
    "rollback to v1",
  ]);
});
