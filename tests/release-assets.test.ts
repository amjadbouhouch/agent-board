import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install.sh derives an asset name from `uname` and release.yml publishes a
 * fixed list. If those drift, every install 404s while the whole suite stays
 * green — the failure only surfaces when a user reports it. So the asset name
 * is read out of the real script, per platform, by stubbing `uname`.
 */
const ROOT = join(import.meta.dir, "..");

const PLATFORMS = [
  { uname_s: "Linux", uname_m: "x86_64", expected: "agent-board-linux-x64" },
  { uname_s: "Linux", uname_m: "aarch64", expected: "agent-board-linux-arm64" },
  { uname_s: "Darwin", uname_m: "x86_64", expected: "agent-board-darwin-x64" },
  { uname_s: "Darwin", uname_m: "arm64", expected: "agent-board-darwin-arm64" },
];

/** Runs install.sh with a stubbed `uname` and returns the asset it requests. */
async function assetRequestedOn(uname_s: string, uname_m: string): Promise<string> {
  const stubDir = await mkdtemp(join(tmpdir(), "agent-board-uname-"));
  const stub = join(stubDir, "uname");
  await writeFile(
    stub,
    `#!/bin/sh\ncase "$1" in\n  -s) echo ${uname_s} ;;\n  -m) echo ${uname_m} ;;\nesac\n`,
  );
  await chmod(stub, 0o755);

  try {
    const proc = Bun.spawn(["sh", join(ROOT, "install.sh")], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        NO_COLOR: "1",
        // Closed port: the script prints the asset it wants, then fails fast.
        AGENT_BOARD_BASE_URL: "http://127.0.0.1:1",
        AGENT_BOARD_INSTALL_DIR: join(stubDir, "bin"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const match = stdout.match(/source\s+\S+\/(agent-board-\S+)/);
    if (!match) throw new Error(`install.sh printed no asset name:\n${stdout}`);
    return match[1]!;
  } finally {
    await rm(stubDir, { recursive: true, force: true });
  }
}

test("release.yml publishes every asset install.sh knows how to ask for", async () => {
  const workflow = await readFile(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const published = [...workflow.matchAll(/asset:\s*(agent-board-\S+)/g)].map((m) => m[1]!);

  expect(published.sort()).toEqual(PLATFORMS.map((p) => p.expected).sort());
});

for (const platform of PLATFORMS) {
  test(`install.sh on ${platform.uname_s}/${platform.uname_m} requests ${platform.expected}`, async () => {
    expect(await assetRequestedOn(platform.uname_s, platform.uname_m)).toBe(platform.expected);
  }, 20_000);
}

test("each published asset is accompanied by a checksum install.sh can verify", async () => {
  const workflow = await readFile(join(ROOT, ".github/workflows/release.yml"), "utf8");

  // install.sh fetches "<asset>.sha256" and refuses to install on a mismatch.
  expect(workflow).toContain("sha256sum ${{ matrix.asset }} > ${{ matrix.asset }}.sha256");
  expect(await readFile(join(ROOT, "install.sh"), "utf8")).toContain('$ASSET.sha256');
});
