import { readFile, rename, writeFile } from "node:fs/promises";
import { CliError } from "./config.ts";

/**
 * Writes through a temporary file in the same directory, then renames.
 * `rename(2)` is atomic within a filesystem, so a reader sees either the whole
 * previous file or the whole new one. A plain write truncates first, which
 * leaves a half-written file if the process dies mid-write.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, contents);
  await rename(temp, path);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

/**
 * Reads and parses JSON, naming the file when it is missing or corrupt. A
 * workspace damaged by an interrupted write should say so, not surface a parse
 * error from somewhere deep in a command.
 */
export async function readJson<T>(path: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new CliError(`Cannot read ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CliError(
      `${path} is not valid JSON — an interrupted write may have truncated it. ` +
        `Recover with \`agent-board restore <workspace> <snapshot>\`.`,
    );
  }
}
