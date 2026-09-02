import { existsSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "./fs.ts";
import { join } from "node:path";
import { checkpoint, create as createDatabase } from "./db.ts";
import { CliError } from "./config.ts";

export interface WorkspaceMetadata {
  id: string;
  name: string;
  createdAt: string;
  /** Sequential business-schema version, incremented per applied migration. */
  dbVersion: number;
  /** Sequential application.json version, incremented per publish. */
  appVersion: number;
}

export interface SnapshotInfo {
  seq: number;
  reason: string;
  dbVersion: number;
  appVersion: number;
  createdAt: string;
}

export interface Workspace {
  id: string;
  root: string;
  dbPath: string;
  applicationPath: string;
  migrationsDir: string;
  snapshotsDir: string;
  metadataPath: string;
}

export function workspacePaths(workspacesDir: string, id: string): Workspace {
  const root = join(workspacesDir, id);
  return {
    id,
    root,
    dbPath: join(root, "data.sqlite"),
    applicationPath: join(root, "application.json"),
    migrationsDir: join(root, "migrations"),
    snapshotsDir: join(root, "snapshots"),
    metadataPath: join(root, "metadata.json"),
  };
}

export function openWorkspace(workspacesDir: string, id: string): Workspace {
  const ws = workspacePaths(workspacesDir, id);
  if (!existsSync(ws.metadataPath)) {
    throw new CliError(`Workspace "${id}" not found in ${workspacesDir}.`);
  }
  return ws;
}

export async function createWorkspace(
  workspacesDir: string,
  id: string,
  name: string,
): Promise<Workspace> {
  const ws = workspacePaths(workspacesDir, id);
  if (existsSync(ws.root)) {
    throw new CliError(`Workspace "${id}" already exists at ${ws.root}.`);
  }
  await mkdir(ws.migrationsDir, { recursive: true });
  await mkdir(ws.snapshotsDir, { recursive: true });

  // Provision the empty SQLite database file.
  createDatabase(ws.dbPath).close();

  const metadata: WorkspaceMetadata = {
    id,
    name,
    createdAt: new Date().toISOString(),
    dbVersion: 0,
    appVersion: 0,
  };
  await writeMetadata(ws, metadata);

  const emptyApplication = {
    dslVersion: "1.0",
    id,
    title: name,
    navigation: [],
    pages: [],
    savedQueries: [],
    actions: [],
    theme: {},
  };
  await writeJsonAtomic(ws.applicationPath, emptyApplication);
  await writeJsonAtomic(join(ws.root, "permissions.json"), { roles: {} });
  await writeJsonAtomic(join(ws.root, "workflows.json"), { workflows: [] });
  return ws;
}

export async function readMetadata(ws: Workspace): Promise<WorkspaceMetadata> {
  return readJson<WorkspaceMetadata>(ws.metadataPath);
}

export async function writeMetadata(ws: Workspace, metadata: WorkspaceMetadata): Promise<void> {
  await writeJsonAtomic(ws.metadataPath, metadata);
}

export async function listWorkspaces(workspacesDir: string): Promise<string[]> {
  if (!existsSync(workspacesDir)) return [];
  const entries = await readdir(workspacesDir, { withFileTypes: true });
  return entries
   .filter((e) => e.isDirectory() && existsSync(join(workspacesDir, e.name, "metadata.json")))
   .map((e) => e.name)
   .sort();
}

/**
 * Copies data.sqlite + application.json + metadata.json into
 * snapshots/{seq}/ before any structural change.
 */
export async function createSnapshot(ws: Workspace, reason: string): Promise<SnapshotInfo> {
  const metadata = await readMetadata(ws);
  const existing = await listSnapshots(ws);
  const seq = (existing.at(-1)?.seq ?? 0) + 1;
  const dir = join(ws.snapshotsDir, String(seq));
  await mkdir(dir, { recursive: true });

  // Checkpoint WAL so the copied file contains all committed data.
  checkpoint(ws.dbPath);

  await cp(ws.dbPath, join(dir, "data.sqlite"));
  await cp(ws.applicationPath, join(dir, "application.json"));

  const info: SnapshotInfo = {
    seq,
    reason,
    dbVersion: metadata.dbVersion,
    appVersion: metadata.appVersion,
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(join(dir, "snapshot.json"), info);
  return info;
}

export async function listSnapshots(ws: Workspace): Promise<SnapshotInfo[]> {
  if (!existsSync(ws.snapshotsDir)) return [];
  const entries = await readdir(ws.snapshotsDir, { withFileTypes: true });
  const infos: SnapshotInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const infoPath = join(ws.snapshotsDir, entry.name, "snapshot.json");
    if (!existsSync(infoPath)) continue;
    infos.push(await readJson<SnapshotInfo>(infoPath));
  }
  return infos.sort((a, b) => a.seq - b.seq);
}

export async function restoreSnapshot(ws: Workspace, seq: number): Promise<SnapshotInfo> {
  const snapshots = await listSnapshots(ws);
  const snapshot = snapshots.find((s) => s.seq === seq);
  if (!snapshot) {
    const available = snapshots.map((s) => s.seq).join(", ") || "none";
    throw new CliError(`Snapshot ${seq} not found. Available: ${available}.`);
  }
  const dir = join(ws.snapshotsDir, String(seq));

  // Remove stale WAL/SHM files so the restored database is authoritative.
  for (const suffix of ["-wal", "-shm"]) {
    const file = Bun.file(ws.dbPath + suffix);
    if (await file.exists()) await file.delete();
  }
  await cp(join(dir, "data.sqlite"), ws.dbPath);
  await cp(join(dir, "application.json"), ws.applicationPath);

  const metadata = await readMetadata(ws);
  metadata.dbVersion = snapshot.dbVersion;
  metadata.appVersion = snapshot.appVersion;
  await writeMetadata(ws, metadata);
  return snapshot;
}
