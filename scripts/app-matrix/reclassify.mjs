import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareEngines, failure, stageOutput } from "./classify.mjs";
import { sha256 } from "./registry.mjs";

const evidence = resolve(process.argv[2] ?? "/work/reports/bun-wasm-app-matrix-2026-10-15");
const output = resolve(process.argv[3] ?? "docs/app-matrix/classifications.md");
const rows = [];
const sources = [];
for (const host of ["native", "playground-light"]) {
  const path = join(evidence, host, "results.json");
  const bytes = readFileSync(path);
  sources.push(`${host}/results.json SHA-256 ${sha256(bytes)}`);
  const report = JSON.parse(bytes);
  for (const row of report.results) rows.push(reclassify(row, host));
}
function reclassify(row, folder) {
  if (row.status !== "fail") return { ...row };
  const logfile = row.host === "native" ? `${row.app}-${row.engine}-${row.stage}.log` : `${row.app}-${row.engine}-playground.log`;
  const log = readFileSync(join(evidence, folder, logfile), "utf8");
  const current = row.host === "native" ? log : stageOutput(log, row.command.replaceAll("{port}", "3137"));
  const classified = failure(current, row.stage);
  if (classified.blocker.endsWith("No diagnostic before exit or deadline")) classified.blocker = row.blocker;
  return { ...row, ...classified, log: `${folder}/${logfile}`, log_sha256: sha256(log) };
}
const classified = compareEngines(rows);
for (const row of classified.filter(row => row.status === "blocked")) {
  const prerequisite = classified.find(other => other.app === row.app && other.engine === row.engine && other.host === row.host && other.stage === row.prerequisite);
  if (prerequisite) Object.assign(row, { category: prerequisite.category, blocker: prerequisite.blocker });
}
const safe = value => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const lines = ["# Retained census classifications", "", `Regenerated from ${evidence}. This updates failure categories only. Original pass assertions predate the strengthened harness and are not revalidated here.`, "", "Reproduce with `bun scripts/app-matrix/reclassify.mjs <evidence-directory>`.", "", ...sources.map(source => `- ${source}`), "", "| App | Engine | Host | Stage | Status | Category | Diagnostic / assertion | Passes on |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
for (const row of classified.filter(row => row.status !== "pass")) lines.push(`| ${row.app} | ${row.engine} | ${row.host} | ${row.stage} | ${row.status} | ${row.category} | ${safe(row.blocker)} | ${row.passesOn?.join(", ") ?? "-"} |`);
writeFileSync(output, lines.join("\n") + "\n");
console.log(JSON.stringify({ rows: classified.length, failures: classified.filter(row => row.status === "fail").length, categories: Object.fromEntries(["a", "b", "c", "d", "e", "f"].map(category => [category, classified.filter(row => row.status === "fail" && row.category === category).length])) }));
