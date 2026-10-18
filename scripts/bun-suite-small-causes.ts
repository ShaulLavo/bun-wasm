import { readFileSync } from "node:fs";
import { join } from "node:path";

const groups: Record<string, string[]> = JSON.parse(readFileSync(new URL("../docs/bun-test-suite/small-causes-files.json", import.meta.url), "utf8"));
const [before, after = before] = process.argv.slice(2);
if (before === "--files") {
  console.log(Array.from(new Set(Object.values(groups).flat())).join("\n"));
  process.exit(0);
}
if (!before) throw new Error("Usage: node scripts/bun-suite-small-causes.ts <results-directory> [after-directory], or --files");

type Result = { file: string; fully_passing: boolean; timed_out: boolean; counts: { pass: number } };
function records(path: string): Map<string, Result> {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (data === null || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results)) throw new Error(`Invalid suite report ${path}`);
  const results = new Map<string, Result>();
  for (const row of data.results) {
    if (!row || typeof row !== "object" || typeof row.file !== "string" || typeof row.fully_passing !== "boolean" || typeof row.timed_out !== "boolean" || typeof row.counts?.pass !== "number") throw new Error(`Invalid file result in ${path}`);
    results.set(row.file, row);
  }
  return results;
}
function count(results: Map<string, Result>, files: readonly string[]) {
  const selected = files.map(file => {
    const row = results.get(file);
    if (!row) throw new Error(`Missing measured file ${file}`);
    return row;
  });
  return `${selected.filter(row => row.fully_passing).length}/${files.length} files, ${selected.reduce((sum, row) => sum + row.counts.pass, 0)} passes, ${selected.filter(row => row.timed_out).length} timeouts`;
}
console.log("| Cause | Engine | Before | After |\n| --- | --- | --- | --- |");
for (const engine of ["quickjs", "jsc", "browser"]) {
  const old = records(join(before, `before-${engine}.json`)), current = records(join(after ?? before, `after-${engine}.json`));
  for (const [name, files] of Object.entries(groups)) console.log(`| ${name} | ${engine} | ${count(old, files)} | ${count(current, files)} |`);
}
