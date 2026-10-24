import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";

export const migrationBase = "ad5716e5a727671f8e501a1030adf84ddeefeb18";
const ledger = "docs/bun-patches.md";
const directory = "docs/bun-patches";
const mappingPath = "scripts/migrations/bun-patches-map.json";
const entrypoint = `# Changes to Bun and other upstream source

[Browse patch and adapter records](bun-patches/). Each record owns its classification,
upstream paths and revisions, local changes, and reasons.

[Scope and class definitions](bun-patches/scope.md) distinguish ports, host features,
and upstream bugs. Add or update the relevant record, not this entrypoint.

The [migration map](../scripts/migrations/bun-patches-map.json) maps the former
single-page anchors to their records. The deterministic splitter and proof are
in [split-bun-patches.ts](../scripts/migrations/split-bun-patches.ts).
`;

type Section = { path: string; text: string; anchor: string; parent: string | undefined };

function slug(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replaceAll(" ", "-");
}

export function splitLedger(source: string) {
  const headings = Array.from(source.matchAll(/^((?:##|###) )(.+)$/gm));
  const first = headings[0]?.index;
  if (first === undefined) throw new Error("No ledger sections");
  const prefix = source.slice(0, first);
  const table = prefix.indexOf("| Patch or source |");
  if (table < 0) throw new Error("Missing classified overview");
  const anchors = new Map<string, string>();
  const sections: Section[] = [];
  let parent: string | undefined;
  for (const [index, heading] of headings.entries()) {
    const anchor = slug(heading[2]!);
    if (anchors.has(anchor) || anchor === "scope") throw new Error(`Duplicate anchor ${anchor}`);
    const path = `${directory}/${anchor}.md`;
    const section = { path, anchor, parent: heading[1] === "### " ? parent : undefined,
      text: source.slice(heading.index, headings[index + 1]?.index ?? source.length) };
    anchors.set(anchor, path);
    sections.push(section);
    if (heading[1] === "## ") parent = path;
  }
  relocateAliases(sections, anchors);
  // The old overview used this spelling, but its heading had no matching anchor.
  const sink = sections.find(section => section.anchor === "bun-arraybuffersink");
  if (sink) sink.text = '<a id="bun-array-buffer-sink"></a>\n\n' + sink.text;
  if (sink) anchors.set("bun-array-buffer-sink", sink.path);
  const rows = prefix.slice(table).split("\n").filter(line => line.startsWith("| ") && line.includes("](#"));
  const ownedRows = new Map<string, string[]>();
  for (const row of rows) {
    const anchor = row.match(/\]\(#([^)]*)\)/)?.[1];
    const path = anchor && anchors.get(anchor);
    if (!path) throw new Error(`Unresolved classification ${anchor}`);
    ownedRows.set(path, (ownedRows.get(path) ?? []).concat([row]));
  }
  const files = new Map<string, string>([[ledger, entrypoint], [`${directory}/scope.md`, prefix.slice(0, table)]]);
  for (const section of sections) {
    const context = section.parent ? `\n[Parent context](${posix.basename(section.parent)}).\n` : "";
    const rows = ownedRows.get(section.path) ?? [];
    const classification = rows.length ? `\n## Classification\n\n| Patch or source | Class | Change |\n| --- | --- | --- |\n${rows.join("\n")}\n` : "";
    files.set(section.path, rewriteLinks(section.text + classification, ledger, section.path, anchors) + context + "\n[Ledger scope and pinned revisions](scope.md).\n");
  }
  files.set(mappingPath, JSON.stringify({ base: migrationBase, anchors: Object.fromEntries(anchors) }, null, 2) + "\n");
  return { files, anchors, sectionCount: sections.length, rowCount: rows.length };
}

function relocateAliases(sections: Section[], anchors: Map<string, string>): void {
  for (const [index, section] of sections.entries()) {
    const alias = section.text.match(/\n(<a id="([^"]+)"><\/a>\n\n)$/);
    if (!alias) continue;
    const next = sections[index + 1];
    if (!next || anchors.has(alias[2]!)) throw new Error("Invalid explicit anchor");
    section.text = section.text.slice(0, -alias[1]!.length);
    next.text = alias[1] + next.text;
    anchors.set(alias[2]!, next.path);
  }
}

export function rewriteLinks(text: string, from: string, to: string, anchors: ReadonlyMap<string, string>): string {
  return text.replace(/\]\(([^)\s]+)\)/g, (whole: string, target: string) => {
    if (/^(?:[a-z]+:|\/)/i.test(target)) return whole;
    const [file, fragment] = target.split("#");
    const original = file ? posix.normalize(posix.join(posix.dirname(from), file)) : from;
    const destination = original === ledger && fragment ? anchors.get(fragment) : original;
    if (!destination) throw new Error(`Unresolved ledger link ${target} in ${from}`);
    const path = destination === to ? "" : posix.relative(posix.dirname(to), destination);
    return `](${path}${fragment ? `#${fragment}` : ""})`;
  });
}

export function migrationOutputs(root: string) {
  const source = execFileSync("git", ["show", `${migrationBase}:${ledger}`], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const split = splitLedger(source);
  const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", migrationBase], { cwd: root, encoding: "utf8" }).trim().split("\n");
  for (const path of tracked.filter(path => path.endsWith(".md") && path !== ledger)) {
    const text = execFileSync("git", ["show", `${migrationBase}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    if (!text.includes("bun-patches.md#")) continue;
    const updated = rewriteLinks(text, path, path, split.anchors);
    if (text !== updated) split.files.set(path, updated);
  }
  return split;
}

if (import.meta.main) {
  const [mode] = process.argv.slice(2);
  if (mode !== "--write" && mode !== "--check") throw new Error("Usage: split-bun-patches.ts --write|--check");
  const root = resolve(import.meta.dir, "../..");
  const output = migrationOutputs(root);
  for (const [path, text] of output.files) {
    const absolute = resolve(root, path);
    if (mode === "--write") { mkdirSync(dirname(absolute), { recursive: true }); writeFileSync(absolute, text); }
    if (!existsSync(absolute) || readFileSync(absolute, "utf8") !== text) throw new Error(`Migration differs: ${path}`);
  }
  console.log(`${output.sectionCount} sections, ${output.rowCount} classified rows, ${output.anchors.size} anchors: exact migration proof passed`);
}
