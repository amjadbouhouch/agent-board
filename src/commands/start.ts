import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, workspacesRoot, CliError } from "../lib/config.ts";
import { createAgentBoard } from "../server/index.ts";

const DEFAULT_PORT = 4000;

export async function cmdStart(args: string[] = []): Promise<number> {
  let port = DEFAULT_PORT;
  let hostname = "localhost";
  let staticDir: string | undefined;
  const allowedOrigins: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--port") {
      const raw = args[++i];
      port = Number(raw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new CliError(`--port must be between 0 and 65535, got "${raw}".`);
      }
    } else if (arg === "--host") {
      const raw = args[++i];
      if (raw === undefined) throw new CliError("--host requires a hostname.");
      hostname = raw;
    } else if (arg === "--static") {
      const raw = args[++i];
      if (raw === undefined) throw new CliError("--static requires a directory.");
      staticDir = resolve(raw);
      if (!existsSync(staticDir)) throw new CliError(`Directory not found: ${staticDir}`);
    } else if (arg === "--cors") {
      const raw = args[++i];
      if (raw === undefined) throw new CliError("--cors requires an origin, e.g. http://localhost:5173.");
      if (raw === "*") {
        throw new CliError(
          "--cors will not accept \"*\". With no authorize hook every workspace is served " +
            "without restriction, so a wildcard would let any page the user visits read them. " +
            "Name the origins, or serve the page with --static and skip CORS entirely.",
        );
      }
      allowedOrigins.push(raw);
    } else {
      throw new CliError(`Unknown option "${arg}".`);
    }
  }

  const config = await loadConfig();
  const dir = workspacesRoot(config);
  const runtime = createAgentBoard({ workspacesDir: dir, staticDir, allowedOrigins });
  const server = Bun.serve({ port, hostname, fetch: runtime.fetch });

  console.log(`AgentBoard runtime on http://${hostname}:${server.port}`);
  console.log(`Serving workspaces from ${dir}`);
  if (staticDir) console.log(`Serving files from ${staticDir}`);
  if (allowedOrigins.length > 0) console.log(`Allowing browser calls from ${allowedOrigins.join(", ")}`);
  console.log(`\nNo authorize hook is configured, so every workspace in that`);
  console.log(`directory is served without restriction. Use createAgentBoard()`);
  console.log(`from your own host application to enforce real permissions.`);

  // Resolves only on SIGINT/SIGTERM, so the process stays up serving requests.
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void server.stop(true).then(() => resolve());
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  return 0;
}
