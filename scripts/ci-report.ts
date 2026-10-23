import { execFileSync } from "node:child_process";

const run = process.argv[2];
if (!run || !/^\d+$/.test(run)) throw new Error("Usage: bun scripts/ci-report.ts <GitHub-run-id>");
const repo = "ShaulLavo/bun-wasm";
function view(args: readonly string[]): string {
  return execFileSync("gh", ["run", "view", run!, "--repo", repo].concat(args), { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
function seconds(start: string, end: string): number {
  const duration = (Date.parse(end) - Date.parse(start)) / 1000;
  if (!Number.isFinite(duration) || duration < 0) throw new Error("Run must have completed timestamps");
  return duration;
}
const [start = "", end = ""] = view(["--json", "createdAt,updatedAt", "--jq", "[.createdAt,.updatedAt]|@tsv"]).trim().split("\t");
const jobs = view(["--json", "jobs", "--jq", ".jobs[]|[.name,.startedAt,.completedAt]|@tsv"]).trim().split("\n");
const logs = view(["--log"]).split("\n");
console.log(`Run ${run}: ${seconds(start, end)}s wall time`);
console.log("| Job | Wall time | Build/cache log evidence |\n| --- | ---: | --- |");
for (const job of jobs) {
  const [name = "", started = "", completed = ""] = job.split("\t");
  const lines = logs.filter(line => line.startsWith(name + "\t"));
  const evidence = lines.filter(line => /Cache (?:hit for:|not found for input keys:)|Patched Bun sysroot verified:|Finished.*target\(s\)|Downloading .*playwright|Built process fixture:/.test(line));
  console.log(`| ${name} | ${seconds(started, completed)}s | ${evidence.length} build/cache records below |`);
  for (const line of evidence) console.error(line);
}
