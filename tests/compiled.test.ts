import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  applyMigration,
  compileBinary,
  createWorkspace,
  newProject,
  runCli,
  shippedBuildFlags,
  startCliServer,
  validSpec,
  type Project,
  type RunningServer,
} from "./helpers.ts";

/**
 * Both compile modes are covered because the flags are not cosmetic: under
 * `--bytecode`, `import.meta.url` reports the build machine's source path, so
 * code that infers "am I a standalone binary?" from it breaks in the release
 * build while every other test stays green. That happened once already.
 */
type Mode = { name: string; flags: string[] };

const PLAIN: Mode = { name: "plain", flags: [] };
const SHIPPED: Mode = { name: "shipped", flags: [] }; // flags filled from package.json

let binaries: Map<string, { path: string; cleanup(): Promise<void> }>;
let project: Project;
let ws: string;
let server: RunningServer | undefined;

beforeAll(async () => {
  SHIPPED.flags = await shippedBuildFlags();
  const built = await Promise.all(
    [PLAIN, SHIPPED].map(async (mode) => [mode.name, await compileBinary(mode.flags)] as const),
  );
  binaries = new Map(built);
});

afterAll(async () => {
  await Promise.all([...binaries.values()].map((binary) => binary.cleanup()));
});

beforeEach(async () => {
  project = await newProject();
  ws = await createWorkspace(project);
  await applyMigration(
    project,
    ws,
    "0001_users.sql",
    "CREATE TABLE users (name TEXT); INSERT INTO users VALUES ('Alice'),('Bob');",
  );
  const spec = validSpec(ws, "Ops");
  spec.savedQueries = [{ name: "users", sql: "SELECT name FROM users ORDER BY name" }];
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

test("the build script still compiles with the flags the tests cover", async () => {
  // Guards the pairing itself: if `build` loses its flags, both modes collapse
  // into the same binary and the bytecode path stops being tested at all.
  expect(SHIPPED.flags).toEqual(["--minify", "--bytecode"]);
});

for (const mode of ["plain", "shipped"]) {
  test(`the ${mode} binary serves saved queries, which run in a child process`, async () => {
    server = await startCliServer(project, [binaries.get(mode)!.path]);

    const response = await fetch(`${server.url}/workspaces/${ws}/queries/users`, {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as any).toMatchObject({
      rows: [{ name: "Alice" }, { name: "Bob" }],
      rowCount: 2,
    });
  });

  test(`the ${mode} binary runs a query from the command line`, async () => {
    const result = await runCli(project.dir, ["query", ws, "--saved", "users"], [
      binaries.get(mode)!.path,
    ]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Alice");
  });
}
