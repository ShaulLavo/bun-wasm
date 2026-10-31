import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, statfsSync } from "node:fs";

function existingPath(paths: readonly string[]): string {
  for (const path of paths) if (existsSync(path)) return path;
  return process.cwd();
}

function diskBytes(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.blocks * 512;
  const output = execFileSync("du", ["-sx", "--block-size=1", "--", path], { encoding: "utf8" });
  const bytes = Number(output.trim().split(/\s+/)[0]);
  if (!Number.isSafeInteger(bytes)) throw new Error(`Invalid disk usage for ${path}`);
  return bytes;
}

function measure(path: string): { path: string; exists: boolean; diskBytes: number } {
  if (!existsSync(path)) return { path, exists: false, diskBytes: 0 };
  return { path, exists: true, diskBytes: diskBytes(path) };
}

const [label, ...paths] = process.argv.slice(2);
if (!label || paths.length === 0) throw new Error("Usage: ci-storage.ts LABEL PATH...");

const filesystem = statfsSync(existingPath(paths));
const measurements = paths.map(measure);
console.log(JSON.stringify({
  component: "ci-storage",
  label,
  freeBytes: filesystem.bavail * filesystem.bsize,
  retainedBytes: measurements.reduce((total, item) => total + item.diskBytes, 0),
  paths: measurements,
}));
