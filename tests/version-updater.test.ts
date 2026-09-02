import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `commit-and-tag-version` bumps two files, and the second one is reached
 * through a regex in scripts/version-updater.cjs. If that regex stops matching
 * src/version.ts, releases keep succeeding while shipping a binary that reports
 * the previous version — so the regex is tested against the real file rather
 * than a fixture.
 *
 * This reaches into a build script rather than a public boundary because the
 * script *is* the boundary: `commit-and-tag-version` is its only caller.
 */
const ROOT = join(import.meta.dir, "..");
const updater = require(join(ROOT, "scripts/version-updater.cjs"));

test("the updater reads the version that src/version.ts actually declares", async () => {
  const [source, pkg] = await Promise.all([
    readFile(join(ROOT, "src/version.ts"), "utf8"),
    readFile(join(ROOT, "package.json"), "utf8").then(JSON.parse),
  ]);

  expect(updater.readVersion(source)).toBe(pkg.version);
});

test("the updater bumps only the version and leaves the rest of the file intact", async () => {
  const source = await readFile(join(ROOT, "src/version.ts"), "utf8");
  const current = updater.readVersion(source);

  const bumped = updater.writeVersion(source, "9.9.9");

  expect(updater.readVersion(bumped)).toBe("9.9.9");
  expect(bumped.replace("9.9.9", current)).toBe(source);
});

test("the updater fails loudly when the constant is gone", () => {
  expect(() => updater.readVersion("export const NOT_IT = \"1.0.0\";\n")).toThrow(
    /no VERSION constant/,
  );
});

test("both bumpFiles targets are configured", async () => {
  const config = JSON.parse(await readFile(join(ROOT, ".versionrc.json"), "utf8"));

  expect(config.bumpFiles.map((f: { filename: string }) => f.filename)).toEqual([
    "package.json",
    "src/version.ts",
  ]);
});
