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

beforeEach(async () => {
  project = await newProject();
  ws = await createWorkspace(project);
});

afterEach(() => project.cleanup());

test("publish users the specification as application version 1", async () => {
  const spec = validSpec(ws, "Order Operations");
  await project.write("app.json", spec);

  const result = await runCli(project.dir, ["publish", ws, "app.json"]);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(await project.json("workspaces", ws, "application.json")).toEqual(spec);
  expect((await project.json("workspaces", ws, "metadata.json")).appVersion).toBe(1);
});

test("publish refuses an invalid specification and leaves the workspace untouched", async () => {
  const before = await project.json("workspaces", ws, "application.json");
  await project.write("bad.json", { dslVersion: "2.9", id: ws, title: "Broken", pages: [] });

  const result = await runCli(project.dir, ["publish", ws, "bad.json"]);

  expect(result.stderr).toContain('Unsupported dslVersion "2.9"');
  expect(result.code).toBe(1);
  expect(await project.json("workspaces", ws, "application.json")).toEqual(before);
  expect((await project.json("workspaces", ws, "metadata.json")).appVersion).toBe(0);
});

test("publish snapshots the previous state, so restore recovers the earlier version pair", async () => {
  const first = validSpec(ws, "Order Operations");
  await project.write("v1.json", first);
  await project.write("v2.json", validSpec(ws, "Renamed Operations"));
  await runCli(project.dir, ["publish", ws, "v1.json"]);
  await runCli(project.dir, ["publish", ws, "v2.json"]);

  // Snapshot #2 was taken just before v2 replaced v1.
  const result = await runCli(project.dir, ["restore", ws, "2"]);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(await project.json("workspaces", ws, "application.json")).toEqual(first);
  expect((await project.json("workspaces", ws, "metadata.json")).appVersion).toBe(1);
});

test("publish rejects a stale expected version without writing", async () => {
  await project.write("v1.json", validSpec(ws));
  await runCli(project.dir, ["publish", ws, "v1.json"]);

  const result = await runCli(project.dir, ["publish", ws, "v1.json", "--expect-version", "0"]);

  expect(result.stderr).toContain("expected application version 0 but the workspace is at 1");
  expect(result.code).toBe(1);
  expect((await project.json("workspaces", ws, "metadata.json")).appVersion).toBe(1);
});

test("inspect lists published application versions with the reason given at publish time", async () => {
  await project.write("v1.json", validSpec(ws));
  await runCli(project.dir, ["publish", ws, "v1.json", "--reason", "add fulfilment chart"]);

  const result = await runCli(project.dir, ["inspect", ws]);

  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Application versions (1):");
  expect(result.stdout).toContain("add fulfilment chart");
});

test("publish rejects a saved query that cannot run against the current schema", async () => {
  const spec = validSpec(ws);
  spec.savedQueries = [{ name: "orders_by_user", sql: "SELECT name FROM users" }];
  await project.write("app.json", spec);

  const result = await runCli(project.dir, ["publish", ws, "app.json"]);

  expect(result.stderr).toContain("orders_by_user");
  expect(result.stderr).toContain("no such table: users");
  expect(result.code).toBe(1);
  expect((await project.json("workspaces", ws, "metadata.json")).appVersion).toBe(0);
});

test("publishing after a restore appends a new version instead of overwriting history", async () => {
  const second = validSpec(ws, "Renamed Operations");
  await project.write("v1.json", validSpec(ws, "Order Operations"));
  await project.write("v2.json", second);
  await project.write("v3.json", validSpec(ws, "Third Operations"));
  await runCli(project.dir, ["publish", ws, "v1.json"]);
  await runCli(project.dir, ["publish", ws, "v2.json"]);
  // Snapshot #2 predates v2, so restoring it rewinds the current version to 1.
  await runCli(project.dir, ["restore", ws, "2"]);

  const republish = await runCli(project.dir, ["publish", ws, "v3.json"]);

  expect(republish.stderr).toBe("");
  expect((await project.json("workspaces", ws, "metadata.json")).appVersion).toBe(3);

  const inspect = await runCli(project.dir, ["inspect", ws]);
  expect(inspect.stdout).toContain("Application versions (3):");

  // Version 2 must still hold the specification it was published with.
  await runCli(project.dir, ["rollback", ws, "2"]);
  expect(await project.json("workspaces", ws, "application.json")).toEqual(second);
});

test("publish rejects a saved query that writes to the database", async () => {
  await applyMigration(project, ws, "0001_users.sql", "CREATE TABLE users (name TEXT);");
  const spec = validSpec(ws);
  spec.savedQueries = [{ name: "orders_by_user", sql: "DELETE FROM users" }];
  await project.write("app.json", spec);

  const result = await runCli(project.dir, ["publish", ws, "app.json"]);

  expect(result.stderr).toContain('saved query "orders_by_user"');
  expect(result.stderr).toContain("read-only");
  expect(result.code).toBe(1);
  expect((await project.json("workspaces", ws, "metadata.json")).appVersion).toBe(0);
});

test("publish rejects a saved query that compiles but fails when it is run", async () => {
  await applyMigration(
    project,
    ws,
    "0001_events.sql",
    `CREATE TABLE events (payload TEXT);
     INSERT INTO events (payload) VALUES ('{not json');`,
  );
  const spec = validSpec(ws);
  spec.savedQueries = [
    { name: "orders_by_user", sql: "SELECT json_extract(payload, '$.rate') AS r FROM events" },
  ];
  await project.write("app.json", spec);

  const result = await runCli(project.dir, ["publish", ws, "app.json"]);

  expect(result.stderr).toContain('saved query "orders_by_user"');
  expect(result.stderr).toContain("malformed JSON");
  expect(result.code).toBe(1);
  expect((await project.json("workspaces", ws, "metadata.json")).appVersion).toBe(0);
});
