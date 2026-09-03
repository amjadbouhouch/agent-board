# Agent Board

Read `README.md` first — it holds the runtime invariants and the gotchas that cost
hours. This file covers commands, architecture, and conventions instead.

## Commands

```sh
bun run cli <args>                  # run the CLI from source, e.g. bun run cli help
bun test                            # whole suite (~13s; compiles binaries, spawns servers)
bun test tests/publish.test.ts      # one file
bun test -t "stale expected version"  # one test by name substring
bun run typecheck                   # tsc --noEmit, covers src/ and tests/
bun run build                       # dist/agent-board, standalone binary
./install.sh --local                # build and install to ~/.agent-board/bin
bun run release:dry                 # preview the next version and changelog
bun run release                     # bump, changelog, commit, tag
```

Bun only — `bun:sqlite` means this cannot run on Node at any version.

## Architecture

`src/cli.ts` dispatches to one file per command in `src/commands/`. Business logic
lives in `src/lib/`, and `src/server/` reuses that same `lib/` rather than
reimplementing anything. There are five chokepoints, and the design depends on
edits going *through* them rather than around:

- **`lib/application.ts` › `publishSpec()` is the only way an application version is
  written.** The four publish gates live inside it, not in the command, so `publish`
  and `rollback` both inherit them. A new write path that skips it silently drops the
  gates.
- **`lib/queries.ts` › `runQuery()` is the only way agent-authored SQL runs.** Read-only
  enforcement and parameter validation live inside it, so its three callers — the CLI
  `query` command, the publish smoke test, and the child process the server spawns —
  cannot diverge on safety.
- **`lib/mutations.ts` is the only way rows are written.** Migrations own schema and
  the backfill that belongs with a schema change; ongoing and bulk data go here. The
  caller names a table, columns and structured filters and the module composes the
  statement, so no write SQL is ever supplied from outside — that is what makes scope
  and injection structural rather than validated. The gates (protected namespace,
  column and numeric-affinity checks, `--where` required, the preview receipt, the
  affected-row cap, the `_audit_row_changes` entry with its before-image) live here so
  a later HTTP route reuses rather than reimplements them. It would still need to map
  the `CliError`s they throw onto `HttpError`, or they arrive as opaque 500s. Do not
  relax `runQuery`'s read-only check to write; that separation is the point.
- **`lib/db.ts` is the only file that imports the SQLite driver.** Seven modules go
  through it. Keeping that true is what makes a `node:sqlite` swap a one-file change.
- **`server/index.ts` › `createAgentBoard()` is the whole HTTP surface**, returning a
  `fetch` handler. `agent-board start` is a thin wrapper that adds no routes and
  configures no `authorize` hook.

The server does not run queries in-process. `server/execute.ts` re-invokes this same
program as a child process via the internal `__run-query` subcommand (`commands/run-query.ts`),
then kills it on deadline. This is why the CLI has a hidden command, and why
compiled-binary detection matters — see the README gotcha.

A workspace directory is the persistence contract: `data.sqlite`, `application.json`,
`metadata.json` (holds the `dbVersion` + `appVersion` pair), `migrations/NNNN_name.sql`,
`applications/NNNN.json` plus `versions.json`, and `snapshots/<seq>/`. Nothing else
stores state; there is no control database.

## Testing convention

**Tests run only at public boundaries. No test imports from `src/lib/`.** They spawn
the real CLI as a subprocess, `fetch` a real server, run the compiled binary, or
execute `install.sh`. `tests/helpers.ts` provides the fixtures (`newProject`,
`runCli`, `startServer`, `startCliServer`, `compileBinary`).

This is deliberate: `src/lib/` internals were restructured repeatedly with zero test
churn. Adding a unit test against `lib/` trades that freedom away — prefer driving the
behaviour through a boundary.

Two tests guard the build itself and should not be weakened: `compiled.test.ts` derives
compile flags from `package.json` and asserts them, and `version.test.ts` asserts
`src/version.ts` matches `package.json`. Both exist because that pairing drifted once
and shipped a broken binary.

## Releasing

Commit messages follow Conventional Commits — `commit-and-tag-version` derives the
version from them, so a wrong prefix ships a wrong version.

`bun run release` bumps `package.json` *and* `src/version.ts` together (via
`scripts/version-updater.cjs`, configured in `.versionrc.json`), writes `CHANGELOG.md`,
commits, and tags `vX.Y.Z`. Then `git push --follow-tags origin main` — the tag is what
triggers `release.yml` to build the four binaries.

`release.yml` runs `typecheck` and the full suite in a `test` job that `build` depends
on, so a tag whose tests fail publishes nothing. `ci.yml` covers pull requests and
manual runs only — it deliberately does not duplicate that check on every push.

Distribution is GitHub Releases plus `install.sh`; there is no npm package.

`install.sh` offers to add its install dir to the shell profile. Under `curl | sh`
stdin is the script, so the prompt reads from `/dev/tty` directly; with no terminal
(CI) it prints the line instead of editing anything. `--modify-path` /
`--no-modify-path` make it scriptable, and the appended line uses `$HOME` so it stays
valid if copied to another machine. The
manifest is `"private": true`, so the `npm publish` hint the release tool prints does
not apply and `npm publish` will refuse. `tests/release-assets.test.ts` runs
`install.sh` against a stubbed `uname` for all four platforms and asserts every name it
requests is published by `release.yml`, because a rename there 404s every install while
the suite stays green.

While the version is below 1.0.0, conventional-commits treats it as pre-major: `feat:`
bumps the **patch**, and only `feat!:` / `BREAKING CHANGE:` bumps the minor. Use
`bun run release -- --release-as minor` to override.

## Conventions

- Errors reaching a user are `CliError` (message only, no stack); errors reaching HTTP
  are `HttpError` with a stable string code. Anything else becomes an opaque 500.
- `_agentboard_*` is the platform SQLite namespace and keeps its original spelling
  after the `agentboard` → `agent-board` rename; the migration ledger lives there, so
  renaming it orphans existing databases.
- Release assets must stay named `agent-board-<os>-<arch>` with a `.sha256` sidecar —
  `install.sh` fetches exactly those names.
