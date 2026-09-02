import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./config.ts";
import { createSnapshot, readMetadata, writeMetadata, type Workspace } from "./workspace.ts";
import { smokeTestSavedQueries } from "./queries.ts";

/**
 * Published specifications are retained per version as
 * applications/0001.json, applications/0002.json, … Version 1 is the first
 * publish; the empty scaffold written at workspace creation is version 0 and
 * has no history file.
 */
export function applicationsDir(ws: Workspace): string {
  return join(ws.root, "applications");
}

export function applicationVersionPath(ws: Workspace, version: number): string {
  return join(applicationsDir(ws), `${String(version).padStart(4, "0")}.json`);
}

export async function listApplicationVersions(ws: Workspace): Promise<number[]> {
  const dir = applicationsDir(ws);
  if (!existsSync(dir)) return [];
  return (await readdir(dir))
   .filter((f) => /^\d+\.json$/.test(f))
   .map((f) => Number(f.replace(".json", "")))
   .sort((a, b) => a - b);
}

/** One entry per published version, kept append-only in applications/versions.json. */
export interface ApplicationVersionRecord {
  version: number;
  reason: string;
  createdAt: string;
  checksum: string;
}

function ledgerPath(ws: Workspace): string {
  return join(applicationsDir(ws), "versions.json");
}

export async function listApplicationVersionRecords(
  ws: Workspace,
): Promise<ApplicationVersionRecord[]> {
  const path = ledgerPath(ws);
  if (!existsSync(path)) return [];
  const records: ApplicationVersionRecord[] = JSON.parse(await readFile(path, "utf8"));
  return records.sort((a, b) => a.version - b.version);
}

export async function readApplicationVersion(ws: Workspace, version: number): Promise<unknown> {
  const path = applicationVersionPath(ws, version);
  if (!existsSync(path)) {
    const available = (await listApplicationVersions(ws)).join(", ") || "none";
    throw new CliError(`Application version ${version} not found. Available: ${available}.`);
  }
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * Snapshots the current state, then writes the specification as the next
 * application version and makes it current. Returns the new version number.
 */
export async function publishSpec(
  ws: Workspace,
  spec: unknown,
  reason: string,
): Promise<number> {
  // Every publish path — new specification or rollback — proves the saved
  // queries still run against the live schema first.
  const broken = smokeTestSavedQueries(ws, spec);
  if (broken.length > 0) {
    throw new CliError(
      `Refusing to publish: ${broken.length} saved quer${broken.length === 1 ? "y" : "ies"} ` +
        `cannot run against the current schema:\n  - ${broken.join("\n  - ")}`,
    );
  }

  await createSnapshot(ws, "pre-publish");
  const metadata = await readMetadata(ws);

  // History is append-only: never reuse a number an earlier publish already
  // took. A restore rewinds metadata.appVersion but must not orphan or
  // overwrite the versions published after that snapshot.
  const published = await listApplicationVersions(ws);
  const version = Math.max(metadata.appVersion, published.at(-1) ?? 0) + 1;
  const body = JSON.stringify(spec, null, 2) + "\n";

  await mkdir(applicationsDir(ws), { recursive: true });
  await writeFile(applicationVersionPath(ws, version), body);
  await writeFile(ws.applicationPath, body);

  const records = await listApplicationVersionRecords(ws);
  records.push({
    version,
    reason,
    createdAt: new Date().toISOString(),
    checksum: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
  });
  await writeFile(ledgerPath(ws), JSON.stringify(records, null, 2) + "\n");

  metadata.appVersion = version;
  await writeMetadata(ws, metadata);
  return version;
}
