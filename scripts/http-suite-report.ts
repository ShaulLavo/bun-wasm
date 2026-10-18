import { readFileSync } from "node:fs";
import { join } from "node:path";

function tsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && text[i + 1] === '"' && quoted) { field += '"'; i++; continue; }
    if (char === '"' && (quoted || field === "")) { quoted = !quoted; continue; }
    if (quoted || (char !== "\t" && char !== "\n")) { field += char; continue; }
    row.push(field);
    field = "";
    if (char !== "\n") continue;
    rows.push(row);
    row = [];
  }
  if (quoted) throw new Error("Unclosed TSV field");
  if (field || row.length) rows.push(row.concat([field]));
  return rows;
}

type Failure = { file: string; test: string; error: string };
function failures(path: string): Failure[] {
  const [header, ...rows] = tsv(readFileSync(path, "utf8"));
  if (!header) throw new Error("Missing scoreboard header");
  const column = (name: string): number => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`Missing scoreboard column ${name}`);
    return index;
  };
  const file = column("file"), category = column("category"), topic = column("topic");
  const test = column("test"), error = column("error");
  return rows.filter(row => row[category] === "d" && row[topic] === "HTTP/server/fetch/WebSocket semantics")
    .map(row => {
      const fileName = row[file], testName = row[test], message = row[error];
      if (fileName === undefined || testName === undefined || message === undefined) throw new Error("Incomplete scoreboard row");
      return { file: fileName, test: testName, error: message };
    });
}

type Result = { file: string; first_errors: string[]; excerpt: string; fully_passing: boolean; timed_out: boolean; complete: boolean; exit: number; counts: { pass: number; fail: number; skip: number; todo: number; errors: number } };
function results(path: string): Map<string, Result> {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!data || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results)) throw new Error(`Invalid report ${path}`);
  const found = new Map<string, Result>();
  for (const row of data.results) {
    if (!row || typeof row.file !== "string" || !Array.isArray(row.first_errors) || !row.first_errors.every((value: unknown) => typeof value === "string") || typeof row.excerpt !== "string" || typeof row.fully_passing !== "boolean" || typeof row.timed_out !== "boolean" || typeof row.complete !== "boolean" || typeof row.exit !== "number" || !["pass", "fail", "skip", "todo", "errors"].every(key => typeof row.counts?.[key] === "number")) throw new Error(`Invalid result in ${path}`);
    found.set(row.file, row);
  }
  return found;
}

function signature(row: Failure, measured?: Result): string {
  if (!measured) return row.error;
  if (measured.fully_passing) return "Fully passing on current main";
  if (measured.complete && measured.exit === 0 && measured.counts.fail === 0 && measured.counts.errors === 0 && measured.counts.pass === 0) return measured.counts.skip || measured.counts.todo ? "Skip-only on current main" : "Empty on current main";
  const first = measured.first_errors.find(line => !/^\s*\d+\s*\|/.test(line));
  if (first) return first.trim();
  const diagnostic = measured.excerpt.split("\n").find(line => /^(?:[A-Z][A-Z_]+|\w*(?:Error|Message)): /.test(line));
  if (diagnostic) return diagnostic.replace(/,? (?:open|scandir|symlink) '.*$/, "");
  return measured.timed_out ? "File timeout without a captured error" : "No captured error";
}

function totals(rows: Map<string, Result>) {
  const values = Array.from(rows.values());
  return {
    files: values.filter(row => row.fully_passing).length,
    pass: values.reduce((sum, row) => sum + row.counts.pass, 0),
    fail: values.reduce((sum, row) => sum + row.counts.fail, 0),
    timeouts: values.filter(row => row.timed_out).length,
  };
}

function compare(before: string, after: string): void {
  console.log("| Engine | Fully passing files | Observed passes | Observed failures | File timeouts |\n| --- | --- | --- | --- | --- |");
  const losses: string[] = [];
  for (const engine of ["quickjs", "jsc", "browser"]) {
    const old = results(join(before, `before-${engine}.json`));
    const current = results(join(after, `after-${engine}.json`));
    if (old.size !== current.size || Array.from(old.keys()).some(file => !current.has(file))) throw new Error(`Selection differs on ${engine}`);
    const first = totals(old), last = totals(current);
    console.log(`| ${engine} | ${first.files}/${old.size} → ${last.files}/${current.size} | ${first.pass} → ${last.pass} | ${first.fail} → ${last.fail} | ${first.timeouts} → ${last.timeouts} |`);
    for (const [file, row] of old) {
      const next = current.get(file);
      if (row.fully_passing && !next?.fully_passing) losses.push(`${engine} lost passing file ${file}`);
      if (next && row.counts.pass > next.counts.pass) losses.push(`${engine} fewer observed passes ${file}: ${row.counts.pass} → ${next.counts.pass}`);
    }
  }
  if (!losses.length) return;
  console.log("\nRequires regression review:\n\n" + losses.map(line => `- ${line}`).join("\n"));
}

if (process.argv[2] === "--compare") {
  const before = process.argv[3];
  if (!before) throw new Error("Usage: node scripts/http-suite-report.ts --compare <before-directory> [after-directory]");
  compare(before, process.argv[4] || before);
  process.exit(0);
}

const [scoreboard = "docs/bun-test-suite/failures.tsv", report] = process.argv.slice(2);
const selected = failures(scoreboard);
if (report === "--files") {
  console.log(selected.map(row => row.file).join("\n"));
  process.exit(0);
}
const measured = report ? results(report) : undefined;
const groups = new Map<string, string[]>();
for (const row of selected) {
  const result = measured?.get(row.file);
  if (measured && !result) throw new Error(`Report is missing ${row.file}`);
  const key = signature(row, result);
  const files = groups.get(key) || [];
  files.push(row.file);
  groups.set(key, files);
}
const ordered = Array.from(groups).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
console.log(`${selected.length} selected files. ${selected.filter(row => row.test === "<collection/hook/exit; no named failure>").length} have no named failure in the scoreboard.\n`);
console.log("| First error | Files | Example |\n| --- | --- | --- |");
for (const [error, files] of ordered) console.log(`| ${cell(error)} | ${files.length} | ${files[0]} |`);
console.log("\n<details>\n<summary>File membership</summary>\n");
for (const [error, files] of ordered) console.log(`\n${error}\n\n${files.map(file => `- \`${file}\``).join("\n")}`);
console.log("\n</details>");
