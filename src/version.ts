/**
 * Single source of truth for the version reported by `agent-board --version`.
 * A compiled binary has no package.json to read at runtime, so this is a
 * constant; `tests/version.test.ts` asserts it matches package.json so the two
 * cannot drift.
 */
export const VERSION = "0.3.0";
