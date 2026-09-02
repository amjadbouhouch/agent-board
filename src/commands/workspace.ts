import { loadConfig, workspacesRoot, CliError } from "../lib/config.ts";
import { createWorkspace, listWorkspaces } from "../lib/workspace.ts";

function slugify(name: string): string {
  return name
   .toLowerCase()
   .replace(/[^a-z0-9]+/g, "-")
   .replace(/^-+|-+$/g, "");
}

export async function cmdWorkspace(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const config = await loadConfig();
  const root = workspacesRoot(config);

  switch (sub) {
    case "create": {
      const name = rest.join(" ").trim() || `workspace-${Date.now().toString(36)}`;
      const id = slugify(name);
      if (!id) throw new CliError(`Cannot derive a workspace id from "${name}".`);
      const ws = await createWorkspace(root, id, name);
      console.log(`Created workspace "${id}" at ${ws.root}`);
      console.log(`  data.sqlite       empty database (WAL mode)`);
      console.log(`  application.json  empty application specification`);
      console.log(`  migrations/       place NNNN_name.sql files here`);
      return 0;
    }
    case "list": {
      const ids = await listWorkspaces(root);
      if (ids.length === 0) {
        console.log("No workspaces yet. Create one with: agent-board workspace create <name>");
      } else {
        for (const id of ids) console.log(id);
      }
      return 0;
    }
    default:
      throw new CliError(`Unknown workspace subcommand "${sub ?? ""}". Use: create, list.`);
  }
}
