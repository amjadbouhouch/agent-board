import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * install.sh is a shipped artifact: if it breaks, nobody can install the
 * product, and a `curl | sh` installer that fails quietly is worse than one
 * that fails loudly. These run the real script.
 */
const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "install.sh");

let installDir: string;

beforeEach(async () => {
  installDir = await mkdtemp(join(tmpdir(), "agent-board-install-"));
});

afterEach(() => rm(installDir, { recursive: true, force: true }));

async function runScript(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["sh", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, AGENT_BOARD_INSTALL_DIR: installDir, NO_COLOR: "1", ...env },
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

test("--local builds from source and installs a runnable binary", async () => {
  const result = await runScript(["--local"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("installed AgentBoard");

  const binary = join(installDir, "agent-board");
  expect(existsSync(binary)).toBe(true);
  const version = Bun.spawn([binary, "--version"], { stdout: "pipe" });
  expect((await new Response(version.stdout).text()).trim()).toMatch(/^\d+\.\d+\.\d+$/);
}, 30_000);

test("running it twice reports a reinstall rather than a first install", async () => {
  await runScript(["--local"]);

  const again = await runScript(["--local"]);

  expect(again.code).toBe(0);
  expect(again.stdout).toContain("reinstalled AgentBoard");
}, 60_000);

test("--uninstall removes the binary", async () => {
  await runScript(["--local"]);

  const result = await runScript(["--uninstall"]);

  expect(result.code).toBe(0);
  expect(existsSync(join(installDir, "agent-board"))).toBe(false);
}, 30_000);

test("it tells you when the install directory is not on PATH", async () => {
  // The temp install dir is never on PATH, so this is the default case.
  const result = await runScript(["--local"]);

  // The message goes to stderr as a warning, with a copyable fix on stdout.
  expect(result.stderr).toContain("is not on your PATH");
  expect(result.stdout).toContain("export PATH=");
}, 30_000);

test("a missing release asset fails with a non-zero exit and points at --local", async () => {
  const result = await runScript([], { AGENT_BOARD_REPO: "agent-board-does-not-exist/nope" });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("download failed");
  expect(result.stderr).toContain("--local");
}, 30_000);

test("an unknown flag is rejected instead of being ignored", async () => {
  const result = await runScript(["--bogus"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("unknown option");
});

test("a tampered download is refused and nothing is installed", async () => {
  // Serve a release whose checksum does not match its binary.
  const releaseDir = await mkdtemp(join(tmpdir(), "agent-board-release-"));
  const target = `${process.platform === "darwin" ? "darwin" : "linux"}-${
    process.arch === "arm64" ? "arm64" : "x64"
  }`;
  const asset = `agent-board-${target}`;
  await writeFile(join(releaseDir, asset), "#!/bin/sh\necho 0.0.0\n");
  const wrong = createHash("sha256").update("something else entirely").digest("hex");
  await writeFile(join(releaseDir, `${asset}.sha256`), `${wrong}  ${asset}\n`);

  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const name = new URL(request.url).pathname.slice(1);
      const file = Bun.file(join(releaseDir, name));
      return new Response(file);
    },
  });

  try {
    const result = await runScript([], {
      AGENT_BOARD_BASE_URL: `http://localhost:${server.port}`,
    });

    expect(result.stderr).toContain("checksum mismatch");
    expect(result.code).toBe(1);
    expect(existsSync(join(installDir, "agent-board"))).toBe(false);
  } finally {
    await server.stop(true);
    await rm(releaseDir, { recursive: true, force: true });
  }
}, 30_000);

test("it warns when another agent-board earlier on PATH would shadow the new install", async () => {
  // A decoy earlier on PATH, as happens when an older copy was installed by
  // hand into a directory that already sits ahead of the install dir.
  const decoyDir = await mkdtemp(join(tmpdir(), "agent-board-decoy-"));
  const decoy = join(decoyDir, "agent-board");
  await writeFile(decoy, "#!/bin/sh\necho 0.0.1\n");
  await Bun.spawn(["chmod", "+x", decoy]).exited;

  try {
    const result = await runScript(["--local"], { PATH: `${decoyDir}:${process.env.PATH}` });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("earlier on your PATH");
    expect(result.stdout).toContain(decoy);
  } finally {
    await rm(decoyDir, { recursive: true, force: true });
  }
}, 30_000);

/**
 * PATH setup is part of installing, but `curl | sh` gives the script no stdin
 * to prompt on and no terminal in CI. So the rule is: prompt on /dev/tty when
 * there is one, never touch a profile without consent, and stay scriptable
 * through flags.
 */
async function runWithHome(
  args: string[],
  home: string,
  shell: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["sh", SCRIPT, "--local", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, SHELL: shell, NO_COLOR: "1", ...env },
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

test("without a terminal it never edits a shell profile on its own", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-board-home-"));
  await writeFile(join(home, ".zshrc"), "# existing config\n");

  try {
    const result = await runWithHome([], home, "/bin/zsh");

    expect(result.code).toBe(0);
    expect(await readFile(join(home, ".zshrc"), "utf8")).toBe("# existing config\n");
    expect(result.stdout).toContain("export PATH=");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

test("--modify-path appends the export line to the zsh profile", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-board-home-"));
  await writeFile(join(home, ".zshrc"), "# existing config\n");

  try {
    const result = await runWithHome(["--modify-path"], home, "/bin/zsh");

    expect(result.code).toBe(0);
    const zshrc = await readFile(join(home, ".zshrc"), "utf8");
    expect(zshrc).toStartWith("# existing config\n");
    expect(zshrc).toContain('export PATH="$HOME/.agent-board/bin:$PATH"');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

test("--modify-path twice does not duplicate the line", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-board-home-"));

  try {
    await runWithHome(["--modify-path"], home, "/bin/zsh");
    await runWithHome(["--modify-path"], home, "/bin/zsh");

    const zshrc = await readFile(join(home, ".zshrc"), "utf8");
    const occurrences = zshrc.split('export PATH="$HOME/.agent-board/bin:$PATH"').length - 1;
    expect(occurrences).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 90_000);

test("fish gets fish_add_path rather than an export line", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-board-home-"));

  try {
    await runWithHome(["--modify-path"], home, "/usr/local/bin/fish");

    const config = await readFile(join(home, ".config/fish/config.fish"), "utf8");
    expect(config).toContain("fish_add_path");
    expect(config).not.toContain("export PATH=");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

test("--no-modify-path wins over --modify-path", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-board-home-"));
  await writeFile(join(home, ".zshrc"), "# existing config\n");

  try {
    await runWithHome(["--modify-path", "--no-modify-path"], home, "/bin/zsh");

    expect(await readFile(join(home, ".zshrc"), "utf8")).toBe("# existing config\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

test("zsh honours ZDOTDIR when it is set", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-board-home-"));
  const zdotdir = join(home, "config", "zsh");

  try {
    await runWithHome(["--modify-path"], home, "/bin/zsh", { ZDOTDIR: zdotdir });

    expect(await readFile(join(zdotdir, ".zshrc"), "utf8")).toContain("export PATH=");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
