import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  applyMigration,
  createWorkspace,
  newProject,
  runCli,
  validSpec,
  type Project,
} from "./helpers.ts";

let project: Project;
let ws: string;

const SCHEMA = `
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT);
INSERT INTO users (id, name, plan) VALUES
  ('u1', 'Alice', 'pro'),
  ('u2', 'Bob', 'free'),
  ('u3', 'Carol', 'pro');
`;

beforeEach(async () => {
  project = await newProject();
  ws = await createWorkspace(project);
  await applyMigration(project, ws, "0001_users.sql", SCHEMA);
});

afterEach(() => project.cleanup());

/** Publishes a spec carrying one saved query. */
async function publishQuery(name: string, sql: string): Promise<void> {
  const spec = validSpec(ws);
  spec.savedQueries = [{ name, sql }];
  (spec.pages as any)[0].components[0].source = { type: "saved_query", query: name };
  await project.write("app.json", spec);
  const result = await runCli(project.dir, ["publish", ws, "app.json"]);
  if (result.code !== 0) throw new Error(`publish failed: ${result.stderr}`);
}

test("query runs a published saved query and prints its rows", async () => {
  await publishQuery("users_by_plan", "SELECT name, plan FROM users ORDER BY name");

  const result = await runCli(project.dir, ["query", ws, "--saved", "users_by_plan"]);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Bob");
  expect(result.stdout).toContain("Alice");
  expect(result.stdout).toContain("Carol");
  expect(result.stdout).toContain("3 rows");
});

test("query runs ad-hoc SQL passed on the command line", async () => {
  const result = await runCli(project.dir, [
    "query",
    ws,
    "SELECT plan, COUNT(*) AS users FROM users GROUP BY plan ORDER BY plan",
  ]);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("plan");
  expect(result.stdout).toContain("pro");
  expect(result.stdout).toContain("2 rows");
});

test("query refuses SQL that writes, leaving the data intact", async () => {
  const result = await runCli(project.dir, ["query", ws, "DELETE FROM users"]);

  expect(result.stderr).toContain("read-only");
  expect(result.code).toBe(1);

  const after = await runCli(project.dir, ["query", ws, "SELECT COUNT(*) AS n FROM users"]);
  expect(after.stdout).toContain("3");
});

test("query refuses a second statement smuggled in after a SELECT", async () => {
  const result = await runCli(project.dir, [
    "query",
    ws,
    "SELECT name FROM users; DROP TABLE users",
  ]);

  expect(result.stderr).toContain("single statement");
  expect(result.code).toBe(1);

  const after = await runCli(project.dir, ["query", ws, "SELECT COUNT(*) AS n FROM users"]);
  expect(after.stdout).toContain("3");
});

test("query caps returned rows by default and says the result was truncated", async () => {
  await applyMigration(
    project,
    ws,
    "0002_many.sql",
    `CREATE TABLE readings (n INTEGER);
     WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 500)
     INSERT INTO readings (n) SELECT n FROM seq;`,
  );

  const result = await runCli(project.dir, ["query", ws, "SELECT n FROM readings ORDER BY n"]);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("100 rows");
  expect(result.stdout).toContain("truncated");
});

test("query honours an explicit --limit", async () => {
  const result = await runCli(project.dir, [
    "query",
    ws,
    "SELECT name FROM users ORDER BY name",
    "--limit",
    "2",
  ]);

  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Bob");
  expect(result.stdout).toContain("Alice");
  expect(result.stdout).not.toContain("Carol");
  expect(result.stdout).toContain("2 rows");
  expect(result.stdout).toContain("truncated");
});

test("query binds named parameters instead of interpolating them", async () => {
  await publishQuery(
    "users_on_plan",
    "SELECT name FROM users WHERE plan = $plan ORDER BY name",
  );

  const result = await runCli(project.dir, [
    "query",
    ws,
    "--saved",
    "users_on_plan",
    "--param",
    "plan=pro",
  ]);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Alice");
  expect(result.stdout).toContain("Carol");
  expect(result.stdout).not.toContain("Bob");
  expect(result.stdout).toContain("2 rows");
});

test("query reports a parameter the statement does not declare", async () => {
  const result = await runCli(project.dir, [
    "query",
    ws,
    "SELECT name FROM users",
    "--param",
    "plan=pro",
  ]);

  expect(result.stderr).toContain("plan");
  expect(result.code).toBe(1);
});

test("query --json emits a machine-readable result", async () => {
  const result = await runCli(project.dir, [
    "query",
    ws,
    "SELECT name FROM users ORDER BY name",
    "--limit",
    "2",
    "--json",
  ]);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    columns: ["name"],
    rows: [{ name: "Alice" }, { name: "Bob" }],
    rowCount: 2,
    truncated: true,
    limit: 2,
  });
});

test("query refuses a --limit above the maximum instead of silently capping it", async () => {
  const result = await runCli(project.dir, ["query", ws, "SELECT name FROM users", "--limit", "999999"]);

  expect(result.stderr).toContain("10000");
  expect(result.code).toBe(1);
});
