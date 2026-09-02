import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI exactly as a user would: a real subprocess in a real directory. */
export async function runCli(
  cwd: string,
  args: string[],
  command: string[] = [process.execPath, CLI],
): Promise<CliResult> {
  const proc = Bun.spawn([...command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export interface Project {
  dir: string;
  /** Path inside the project directory. */
  path(...parts: string[]): string;
  /** Reads and parses a JSON file inside the project directory. */
  json(...parts: string[]): Promise<any>;
  /** Writes a file inside the project directory. */
  write(name: string, contents: unknown): Promise<string>;
  cleanup(): Promise<void>;
}

/** An initialized project directory containing one workspace with the given id. */
export async function newProject(): Promise<Project> {
  const dir = await mkdtemp(join(tmpdir(), "agent-board-test-"));
  const project: Project = {
    dir,
    path: (...parts) => join(dir, ...parts),
    json: async (...parts) => JSON.parse(await readFile(join(dir, ...parts), "utf8")),
    write: async (name, contents) => {
      const file = join(dir, name);
      const body = typeof contents === "string" ? contents : JSON.stringify(contents, null, 2);
      await writeFile(file, body);
      return file;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
  const init = await runCli(dir, ["init"]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`);
  return project;
}

/** Creates a workspace and returns its slug id. */
export async function createWorkspace(project: Project, name = "Ops"): Promise<string> {
  const result = await runCli(project.dir, ["workspace", "create", name]);
  if (result.code !== 0) throw new Error(`workspace create failed: ${result.stderr}`);
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** A valid dashboard specification for workspace `id`. */
export function validSpec(id: string, title = "Order Operations"): Record<string, unknown> {
  return {
    dslVersion: "1.0",
    id,
    title,
    navigation: [{ label: "Overview", page: "overview" }],
    savedQueries: [{ name: "orders_by_user", sql: "SELECT 1 AS fulfilled_rate" }],
    pages: [
      {
        id: "overview",
        type: "dashboard",
        title: "Overview",
        components: [
          {
            id: "orders-by-user",
            type: "bar_chart",
            title: "Order Fulfilment by User",
            source: { type: "saved_query", query: "orders_by_user" },
            mapping: { x: "user_name", y: "fulfilled_rate" },
          },
        ],
      },
    ],
  };
}

/** Writes a migration file into the workspace and applies it. */
export async function applyMigration(
  project: Project,
  ws: string,
  file: string,
  sql: string,
): Promise<void> {
  await writeFile(join(project.dir, "workspaces", ws, "migrations", file), sql);
  const result = await runCli(project.dir, ["migrate", ws]);
  if (result.code !== 0) throw new Error(`migrate failed: ${result.stderr}`);
}

export interface RunningServer {
  url: string;
  stop(): Promise<void>;
}

/**
 * Boots the runtime in-process through the embedder entry point on
 * an ephemeral port. This is the seam a host application integrates against.
 */
export async function startServer(
  project: Project,
  options: {
    authorize?: (context: unknown) => boolean | Promise<boolean>;
    queryTimeoutMs?: number;
  } = {},
): Promise<RunningServer> {
  const { createAgentBoard } = await import("../src/server/index.ts");
  const runtime = createAgentBoard({
    workspacesDir: join(project.dir, "workspaces"),
   ...options,
  });
  const server = Bun.serve({ port: 0, fetch: runtime.fetch });
  return {
    url: `http://localhost:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}

/**
 * Spawns `agent-board start --port 0` and waits for it to report the port it
 * bound, so the test never has to guess a free one.
 */
export async function startCliServer(
  project: Project,
  command: string[] = [process.execPath, CLI],
): Promise<RunningServer> {
  const proc = Bun.spawn([...command, "start", "--port", "0"], {
    cwd: project.dir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 10_000;
  for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
    output += decoder.decode(chunk);
    const match = output.match(/http:\/\/\S+?:(\d+)/);
    if (match) {
      return {
        url: `http://localhost:${match[1]}`,
        stop: async () => {
          proc.kill();
          await proc.exited;
        },
      };
    }
    if (Date.now() > deadline) break;
  }
  proc.kill();
  const stderr = await new Response(proc.stderr).text();
  throw new Error(`start never reported a port.\nstdout: ${output}\nstderr: ${stderr}`);
}

/**
 * Writes application.json straight into the workspace, bypassing the publish
 * gates. Models a specification that was valid when published but has become
 * pathological since — for example because the data grew.
 */
export async function forcePublishedSpec(
  project: Project,
  ws: string,
  spec: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(project.dir, "workspaces", ws, "application.json"),
    JSON.stringify(spec, null, 2),
  );
}

/**
 * Compiles the standalone executable. Both the CLI and the internal
 * query-execution entry have to work from inside the binary, and that path is
 * invisible to every other test — a bundling regression would otherwise only
 * surface after publishing.
 */
export async function compileBinary(
  flags: string[] = [],
): Promise<{ path: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-board-build-"));
  const path = join(dir, "agent-board");
  const build = Bun.spawn([process.execPath, "build", "--compile", ...flags, CLI, "--outfile", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`compile failed: ${stderr}`);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * The compile flags the published build actually uses, read from the `build`
 * script rather than duplicated here. The flags change what `import.meta.url`
 * reports inside the binary, so a test that hardcoded them would silently stop
 * covering the real release build the moment the script changed.
 */
export async function shippedBuildFlags(): Promise<string[]> {
  const pkg = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8"));
  const script: string = pkg.scripts.build;
  return script
   .split(/\s+/)
   .filter((token) => token.startsWith("--") && token !== "--compile" && token !== "--outfile");
}
