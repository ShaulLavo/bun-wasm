import { execFileSync } from "node:child_process";

const run = process.argv[2];
const attempt = process.argv[3];
if (!run || !/^\d+$/.test(run) || (attempt !== undefined && !/^[1-9]\d*$/.test(attempt))) throw new Error("Usage: bun scripts/ci-report.ts <GitHub-run-id> [attempt]");
const repo = "ShaulLavo/bun-wasm";
function view(args: readonly string[]): string {
  return execFileSync("gh", ["run", "view", run!, "--repo", repo].concat(attempt ? ["--attempt", attempt] : [], args), { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
function seconds(start: string, end: string): number {
  const duration = (Date.parse(end) - Date.parse(start)) / 1000;
  if (!Number.isFinite(duration) || duration < 0) throw new Error("Run must have completed timestamps");
  return duration;
}
const [selectedAttempt = "", ...jobs] = view(["--json", "attempt,jobs", "--jq", ".attempt, (.jobs[]|[.name,.startedAt,.completedAt]|@tsv)"]).trim().split("\n");
if (!jobs.length) throw new Error("Run must have completed jobs");
const starts = jobs.map(job => job.split("\t")[1] ?? "").sort();
const ends = jobs.map(job => job.split("\t")[2] ?? "").sort();
const logs = view(["--log"]).split("\n");
console.log(`Run ${run}, attempt ${selectedAttempt}: ${seconds(starts[0]!, ends.at(-1)!)}s execution wall time, first job start to last job finish; queue time excluded`);
console.log("| Job | Wall time | Build/cache log evidence |\n| --- | ---: | --- |");
for (const job of jobs) {
  const [name = "", started = "", completed = ""] = job.split("\t");
  const lines = logs.filter(line => line.startsWith(name + "\t"));
  const evidence = lines.filter(line => /Cache (?:hit for:|not found for input keys:)|Patched Bun sysroot verified:|Finished.*target\(s\)|Downloading .*playwright|Built process fixture:/.test(line));
  console.log(`| ${name} | ${seconds(started, completed)}s | ${evidence.length} build/cache records below |`);
  for (const line of evidence) console.error(line);
}
