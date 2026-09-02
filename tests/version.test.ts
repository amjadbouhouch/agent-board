import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { newProject, runCli, type Project } from "./helpers.ts";

let project: Project;

test("--version reports the package version", async () => {
  project = await newProject();
  try {
    const pkg = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
    );

    const result = await runCli(project.dir, ["--version"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  } finally {
    await project.cleanup();
  }
});
