# AgentBoard

Runtime for agent-created data applications. An agent writes SQL migrations and a
declarative dashboard specification; the runtime stores, validates and serves them.
Applications keep serving after every agent process has exited.

Commands: `agent-board help` · Scripts: `package.json` · Verify: `bun test && bun run typecheck`

## The boundary

- The agent owns the business schema and the application specification. The runtime
  owns what keeps them safe: migrations, versioning, read-only enforcement,
  deadlines, permissions. Agent-authored SQL never reaches a writable connection.
- `_agentboard_*`, `_auth_*`, `_audit_*` are platform namespaces; migrations and row
  writes touching them are rejected. The ledger lives in `_agentboard_migrations`, so
  renaming that prefix orphans it in every existing database.

## Migrations own schema, `rows` owns data

- Migrations carry the schema, and the backfill that belongs with a schema change —
  add a column, populate it, constrain it. Ongoing and bulk data changes go through
  `rows`, so the ledger does not become a replay log of every edit ever made.
- `rows insert|update|delete` is that path. The caller names a table, columns and
  filters; the runtime composes the statement, so agent-authored SQL never reaches a
  writable connection at all.
- `update` and `delete` **preview by default**. The preview returns a receipt covering
  the intent *and* the matched rows; `--apply <receipt>` refuses if either moved since.
  The match, the gates and the write share one immediate transaction, so the lock is
  held from the moment the set is identified — checking outside it only narrows the
  window the receipt exists to close — the same window `publish --expect-version` closes
  for application versions. Row order is not part of the receipt.
- Both refuse without `--where`, and refuse past the affected-row cap without `--force`.
  `insert` applies directly: it can only add.
- SQLite's affinity rules accept a non-numeric string into an INTEGER column without
  complaint — a thousands separator is enough, so `"1,200"` lands as text and every
  later `SUM()` over that column is silently wrong. Numeric columns are checked here
  rather than trusted to the driver.
- Applied changes land in `_audit_row_changes` with a before-image, which is what makes
  a delete recoverable; previews write nothing.
- `@null` means SQL NULL in `--set` and `--where`; a bare `null` is the literal text.
- `insert --returning` hands back each row as stored. It is the only way to learn a
  generated key — a `DEFAULT (lower(hex(randomblob(16))))` id leaves nothing to query
  back by. Off unless asked, so a bulk load is not held in memory twice.

## A column means what the schema says, not what it is called

`created_at` works as a column `DEFAULT`. **`updated_at` needs a trigger** — `rows
update` will not touch a column because of its name, so a column with only a `DEFAULT`
records insert time forever while looking correct:

```sql
CREATE TRIGGER items_touch AFTER UPDATE ON items
BEGIN
  UPDATE items SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;
```

It cannot loop: `PRAGMA` is refused inside migrations, so `recursive_triggers` stays off.


## A component asks for the rows it needs

A component's `source` is `{ type, query, parameters?, limit?, offset?, sort? }`, and
the same `limit`, `offset` and `sort` are accepted in the query request body, so a
renderer can page and re-sort without republishing.

- Set `limit` when the component needs more than the default 100 rows; the runtime
  returns up to 10,000, but only if asked. A table that omits it renders its first page
  and says nothing about the rest — which is how a 460-row catalogue quietly becomes a
  100-row one.
- `sort` is an array of result columns, `-name` for descending.
- **`offset` is only meaningful with `sort`.** SQL has no inherent row order, so paging
  an unordered query repeats rows on one page and skips them on the next, with nothing
  to signal it.
- `truncated` in the response is the "there is a next page" flag, and it is exact: a
  page that ends on the last row reports `false` rather than guessing from a full page.
- Ordering and paging are applied by wrapping the saved query as a subquery, never by
  splicing text into it, and every column name is checked against the columns the query
  actually returns. That check is not defensive: SQLite resolves an unmatched
  double-quoted identifier to a *string literal*, so `ORDER BY "nope"` sorts every row
  by a constant and silently returns them unordered.

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
