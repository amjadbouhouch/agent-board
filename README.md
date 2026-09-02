# AgentBoard

Runtime for agent-created data applications. An agent writes SQL migrations and a
declarative dashboard specification; the runtime stores, validates and serves them.
Applications keep serving after every agent process has exited.

Commands: `agent-board help` · Scripts: `package.json` · Verify: `bun test && bun run typecheck`

## The boundary

- The agent owns the business schema and the application specification. The runtime
  owns what keeps them safe: migrations, versioning, read-only enforcement,
  deadlines, permissions. Agent-authored SQL never reaches a writable connection.
- `_agentboard_*`, `_auth_*`, `_audit_*` are platform namespaces and migrations
  touching them are rejected. The ledger lives in `_agentboard_migrations`, so
  renaming that prefix orphans it in every existing database.

## Publish refuses on purpose

- Four gates run before anything is written: DSL validation, `--expect-version`
  concurrency, a read-only check per saved query, and a smoke test that **executes**
  each saved query at `LIMIT 1` with declared parameters bound to NULL.
- Executing rather than compiling is deliberate: `json_extract` over malformed JSON
  compiles clean and fails at run time. A refusal means the specification and the
  database disagree — fix one of them.
- History is append-only in `workspaces/<id>/applications/`. Publish never reuses a
  version number, so `restore` rewinding `metadata.appVersion` cannot clobber later
  versions. `rollback` republishes an old version as a *new* one through the gates.

## Queries

- Callers pass a saved-query **name and parameters, never SQL** — statement text is
  read only from the published specification. Read-only is enforced twice: a keyword
  allowlist, then `PRAGMA query_only = ON`.
- Parameters are bound, never interpolated. `bun:sqlite` silently binds NULL for a
  name the statement never declared, returning wrong rows quietly, so unknown *and*
  missing parameter names are hard errors.
- Each query runs in a child process killed at `queryTimeoutMs`. `bun:sqlite` exposes
  no `sqlite3_interrupt` and SQLite work is synchronous, so killing a process is the
  only available unit of cancellation.

## Gotchas that cost hours

- Detect a compiled binary with `Bun.isStandaloneExecutable`. Under `--bytecode`,
  `import.meta.url` reports the *build machine's* source path.
- Every connection sets `PRAGMA busy_timeout`; SQLite's default of 0 makes concurrent
  opens of one WAL database fail with `SQLITE_BUSY`.
- `bun:sqlite` is imported in `src/lib/db.ts` only. Keep it there.
- `tests/compiled.test.ts` reads compile flags from `package.json` and asserts them.
  Editing the `build` script without it is how the release binary broke once.
