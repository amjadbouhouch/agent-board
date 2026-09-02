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

/** Rollback is append-only: history is never discarded, so the restored spec becomes a new version. */
test("rollback republishes an earlier version as the newest version", async () => {
  const first = validSpec(ws, "Order Operations");
  const second = validSpec(ws, "Renamed Operations");
  await project.write("v1.json", first);
  await project.write("v2.json", second);
  await runCli(project.dir, ["publish", ws, "v1.json"]);
  await runCli(project.dir, ["publish", ws, "v2.json"]);

  const result = await runCli(project.dir, ["rollback", ws, "1"]);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(await project.json("workspaces", ws, "application.json")).toEqual(first);
  expect((await project.json("workspaces", ws, "metadata.json")).appVersion).toBe(3);
});

test("rollback to an unknown version fails and lists what is available", async () => {
  await project.write("v1.json", validSpec(ws));
  await runCli(project.dir, ["publish", ws, "v1.json"]);

  const result = await runCli(project.dir, ["rollback", ws, "7"]);

  expect(result.stderr).toContain("Application version 7 not found. Available: 1.");
  expect(result.code).toBe(1);
  expect((await project.json("workspaces", ws, "metadata.json")).appVersion).toBe(1);
});

test("rollback refuses a version whose saved queries no longer match the schema", async () => {
  await applyMigration(project, ws, "0001_users.sql", "CREATE TABLE users (name TEXT);");
  const usesStores = validSpec(ws);
  usesStores.savedQueries = [{ name: "orders_by_user", sql: "SELECT name FROM users" }];
  await project.write("v1.json", usesStores);
  await project.write("v2.json", validSpec(ws, "No Users"));
  await runCli(project.dir, ["publish", ws, "v1.json"]);
  await applyMigration(project, ws, "0002_drop_users.sql", "DROP TABLE users;");
  await runCli(project.dir, ["publish", ws, "v2.json"]);

  const result = await runCli(project.dir, ["rollback", ws, "1"]);

  expect(result.stderr).toContain("no such table: users");
  expect(result.code).toBe(1);
  expect((await project.json("workspaces", ws, "metadata.json")).appVersion).toBe(2);
});
