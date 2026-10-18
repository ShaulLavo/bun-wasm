import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const check = process.argv.includes("--check");
const source = new URL("docs/bun-test-suite/category-d-first-errors.tsv", root);
const rows = readFileSync(source, "utf8").trimEnd().split("\n").slice(1).map(line => {
  const [file, test, error, cause] = line.split("\t");
  if (!file || !test || !error || !cause) throw new Error(`Invalid first-blocker row: ${line}`);
  return { file, test, error, cause };
});
if (rows.length !== 720 || new Set(rows.map(row => row.file)).size !== 720) throw new Error("Expected 720 distinct baseline files");
const titles: unknown = JSON.parse(readFileSync(new URL("docs/bun-test-suite/category-d-causes.json", root), "utf8"));
if (typeof titles !== "object" || titles === null) throw new Error("Expected cause titles");

function title(id: string): string {
  const value: unknown = Reflect.get(titles, id);
  if (typeof value !== "string") throw new Error(`Missing cause title: ${id}`);
  return value;
}

function groups(key: "error" | "cause") {
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const items = grouped.get(row[key]) || [];
    items.push(row);
    grouped.set(row[key], items);
  }
  return Array.from(grouped, ([id, members]) => ({ id, members })).sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
}

function table(headers: string[], data: string[][]): string {
  const row = (cells: string[]) => "| " + cells.map(cell => cell.replaceAll("|", "\\|")).join(" | ") + " |";
  return [row(headers), row(headers.map(() => "---"))].concat(data.map(row)).join("\n");
}

const document = new URL("docs/bun-test-suite/category-d-runtime.md", root);
const original = readFileSync(document, "utf8");
let text = original;
function section(name: string, content: string) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const first = text.indexOf(start);
  const last = text.indexOf(end);
  if (first < 0 || last < first) throw new Error(`Missing ${name} section`);
  text = text.slice(0, first) + start + "\n" + content + "\n" + text.slice(last);
}

const errors = groups("error");
section("first-errors", table(["Recorded first error", "Files", "Example"], errors.map(group => [
  "`" + group.id.replaceAll("`", "'") + "`", String(group.members.length), "`" + group.members[0].file + "`",
])));
const causes = groups("cause");
for (const cause of causes) title(cause.id);
section("causes", table(["Baseline root cause", "Files", "Example"], causes.filter(group => group.members.length > 1).map(group => [
  title(group.id), String(group.members.length), "`" + group.members[0].file + "`",
])));
if (text !== original && check) throw new Error("Run node scripts/group-suite-category-d.ts");
if (text !== original) writeFileSync(document, text);
console.log(`${rows.length} files; ${errors.length} first-error groups; ${causes.length - 1} assigned root causes; ${rows.filter(row => row.cause === "unknown").length} require further diagnosis. ${check ? "Verified" : "Generated"}.`);
