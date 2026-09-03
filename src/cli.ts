#!/usr/bin/env bun
import { CliError } from "./lib/config.ts";
import { VERSION } from "./version.ts";
import { cmdInit } from "./commands/init.ts";
import { cmdStart } from "./commands/start.ts";
import { cmdWorkspace } from "./commands/workspace.ts";
import { cmdInspect } from "./commands/inspect.ts";
import { cmdValidate } from "./commands/validate.ts";
import { cmdMigrate } from "./commands/migrate.ts";
import { cmdQuery } from "./commands/query.ts";
import { cmdRows } from "./commands/rows.ts";
import { cmdRunQuery } from "./commands/run-query.ts";
import { RUN_QUERY_COMMAND } from "./server/execute.ts";
import { cmdPublish } from "./commands/publish.ts";
import { cmdRollback } from "./commands/rollback.ts";
import { cmdExport } from "./commands/export.ts";
import { cmdRestore } from "./commands/restore.ts";

const HELP = `agent-board — runtime for agent-created data applications

Usage:
  agent-board --version                         Print the installed version
  agent-board init                              Initialize a project in the current directory
  agent-board start [--port <n>] [--host <h>]   Serve published applications over HTTP
  agent-board workspace create [name]           Create an empty workspace
  agent-board workspace list                    List workspaces
  agent-board inspect <workspace>               Show schema, migrations, versions, and snapshots
  agent-board validate <application.json>       Validate a specification against the DSL
  agent-board migrate <workspace>               Apply pending migrations (snapshots first)
  agent-board query <workspace> <sql|--saved n> Run a read-only query
  agent-board rows <insert|update|delete> …     Write rows (see rows options)
  agent-board publish <workspace> <spec.json>   Validate and publish an application specification
  agent-board rollback <workspace> <version>    Republish an earlier application version
  agent-board export <workspace> [out.tar.gz]   Export a workspace as a tarball
  agent-board restore <workspace> <snapshot>    Restore a snapshot by sequence number

Query options:
  --saved <name>              Run a saved query from the published specification
  --param <name>=<value>      Bind a declared parameter (repeatable)
  --limit <n>                 Maximum rows to return (default 100)
  --offset <n>                Rows to skip; pair it with --sort
  --sort <col>                Order by a result column, -col for descending (repeatable)
  --json                      Emit a machine-readable result

Server options:
  --port <n>                  Port to listen on (default 4000, 0 picks a free one)
  --host <h>                  Hostname to bind (default localhost)
  --static <dir>              Also serve files from a directory, so a UI is same-origin
  --cors <origin>             Allow browser calls from an origin (repeatable, no "*")

Rows options:
  --data <json>               Rows to insert, a JSON object or array
  --data-file <path>          Read the rows to insert from a JSON file
  --returning                 Return inserted rows, including generated keys
  --set <col>=<value>         Column to write on update (repeatable)
  --where <col><op><value>    Filter rows; ops != <= >= = < > ~ (~ is contains)
  ...                         Use @null for SQL NULL; bare null is literal text
  --apply <receipt>           Apply the change a preview described
  --force                     Allow an applied change beyond the row cap
  --json                      Emit a machine-readable result

Publish options:
  --reason <message>          Recorded in the application version history
  --expect-version <n>        Refuse to publish unless the workspace is at version n
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return 0;
  }
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return command ? 0 : 1;
  }

  switch (command) {
    case "init":
      return cmdInit();
    case "start":
      return cmdStart(args);
    case "workspace":
      return cmdWorkspace(args);
    case "inspect":
      return cmdInspect(args);
    case "validate":
      return cmdValidate(args);
    case "migrate":
      return cmdMigrate(args);
    case "query":
      return cmdQuery(args);
    case "rows":
      return cmdRows(args);
    case RUN_QUERY_COMMAND:
      return cmdRunQuery();
    case "publish":
      return cmdPublish(args);
    case "rollback":
      return cmdRollback(args);
    case "export":
      return cmdExport(args);
    case "restore":
      return cmdRestore(args);
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      return 1;
  }
}

// Not a top-level await: bytecode compilation (`bun build --bytecode`) cannot
// handle one, and it is what gives the compiled binary its fast startup.
main(Bun.argv.slice(2))
 .then((code) => process.exit(code))
 .catch((error) => {
    if (error instanceof CliError) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  });
