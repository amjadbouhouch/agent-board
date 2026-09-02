import { test, expect, beforeEach, afterEach } from "bun:test";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyMigration,
  createWorkspace,
  newProject,
  runCli,
  startServer,
  validSpec,
  type Project,
  type RunningServer,
} from "./helpers.ts";

/**
 * publishSpec writes four files. A crash between any two must leave the
 * workspace wholly on the old version or wholly on the new one — never
 * reporting one version while serving another. Each test stages the exact
 * partial state a crash at that point would leave behind.
 */
let project: Project;
let ws: string;
let server: RunningServer | undefined;

beforeEach(async () => {
  project = await newProject();
  ws = await createWorkspace(project);
  await applyMigration(project, ws, "0001_t.sql", "CREATE TABLE t (n INT); INSERT INTO t VALUES (1);");

  const first = validSpec(ws, "Version One");
  first.savedQueries = [{ name: "q", sql: "SELECT n FROM t" }];
  (first.pages as any)[0].components[0].source = { type: "saved_query", query: "q" };
  await project.write("v1.json", first);
  const published = await runCli(project.dir, ["publish", ws, "v1.json", "--reason", "first"]);
  if (published.code !== 0) throw new Error(published.stderr);

  const second = validSpec(ws, "Version Two");
  second.savedQueries = [{ name: "q", sql: "SELECT n FROM t" }];
  (second.pages as any)[0].components[0].source = { type: "saved_query", query: "q" };
  await project.write("v2.json", second);
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await project.cleanup();
});

const wsPath = (...parts: string[]) => join("workspaces", ws, ...parts);

/** What every reader should agree on: still version 1, titled "Version One". */
async function expectStillOnVersionOne() {
  const inspect = await runCli(project.dir, ["inspect", ws]);
  expect(inspect.stderr).toBe("");
  expect(inspect.stdout).toContain("application v1");

  server = await startServer(project);
  const [application, versions] = await Promise.all([
    fetch(`${server.url}/workspaces/${ws}/application`).then((r) => r.json() as any),
    fetch(`${server.url}/workspaces/${ws}/application/versions`).then((r) => r.json() as any),
  ]);

  expect(versions.current).toBe(1);
  expect(application.title).toBe("Version One");
}

test("a crash after the history file is written leaves the workspace on version 1", async () => {
  await copyFile(project.path("v2.json"), project.path(wsPath("applications", "0002.json")));

  await expectStillOnVersionOne();
});

test("a crash after the current specification is written leaves the workspace on version 1", async () => {
  await copyFile(project.path("v2.json"), project.path(wsPath("applications", "0002.json")));
  await copyFile(project.path("v2.json"), project.path(wsPath("application.json")));

  await expectStillOnVersionOne();
});

test("a crash after the ledger is written leaves the workspace on version 1", async () => {
  await copyFile(project.path("v2.json"), project.path(wsPath("applications", "0002.json")));
  await copyFile(project.path("v2.json"), project.path(wsPath("application.json")));
  const ledger = await project.json(wsPath("applications", "versions.json"));
  ledger.push({ version: 2, reason: "second", createdAt: new Date().toISOString(), checksum: "x" });
  await writeFile(
    project.path(wsPath("applications", "versions.json")),
    JSON.stringify(ledger, null, 2),
  );

  await expectStillOnVersionOne();
});

test("a truncated specification is reported, not thrown as a stack trace", async () => {
  await writeFile(project.path(wsPath("applications", "0001.json")), '{"dslVersion": "1.0", "id": "de');

  const result = await runCli(project.dir, ["inspect", ws]);

  expect(result.stderr).toContain("0001.json");
  expect(result.stderr).not.toContain("Bun v");
  expect(result.code).toBe(1);
});

test("truncated workspace metadata is reported, not thrown as a stack trace", async () => {
  await writeFile(project.path(wsPath("metadata.json")), '{"id": "de');

  const result = await runCli(project.dir, ["inspect", ws]);

  expect(result.stderr).toContain("metadata.json");
  expect(result.stderr).not.toContain("Bun v");
  expect(result.code).toBe(1);
});
