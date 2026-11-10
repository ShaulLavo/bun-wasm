import { copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { parseFixtureTree, type FixtureEntry } from "../web/tests/fixture-tree";

async function inventory(source: string, directory: string, entries: FixtureEntry[]): Promise<void> {
  const names = await readdir(join(source, directory));
  names.sort();
  for (const name of names) await inventoryEntry(source, directory ? `${directory}/${name}` : name, entries);
}

async function inventoryEntry(source: string, path: string, entries: FixtureEntry[]): Promise<void> {
  const absolute = join(source, path);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error(`Unsupported fixture symlink: ${path}`);
  if (!info.isFile() && !info.isDirectory()) throw new Error(`Unsupported fixture entry: ${path}`);
  entries.push({ kind: info.isDirectory() ? "directory" : "file", path });
  if (info.isDirectory()) await inventory(source, path, entries);
}

/** Copy the whole installed tree. Never resolve packages or filter by filename extension. */
export async function stageFixtureTree(source: string, destination: string): Promise<FixtureEntry[]> {
  source = await realpath(source);
  destination = resolve(destination);
  if (destination === source || destination.startsWith(source + sep)) throw new Error("Fixture destination must be outside its source");
  if (!(await lstat(source)).isDirectory()) throw new Error("Fixture source must be a directory");
  const entries: FixtureEntry[] = [];
  await inventory(source, "", entries);
  const validated = parseFixtureTree(entries);
  await mkdir(destination);
  for (const entry of validated) await copyEntry(source, destination, entry);
  return validated;
}

async function copyEntry(source: string, destination: string, entry: FixtureEntry): Promise<void> {
  const path = join(destination, entry.path);
  await mkdir(dirname(path), { recursive: true });
  if (entry.kind === "directory") await mkdir(path, { recursive: true });
  else await copyFile(join(source, entry.path), path);
}
