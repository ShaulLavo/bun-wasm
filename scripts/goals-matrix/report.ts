import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browsers, browserLabels, engines, frameworks, boxId } from "./catalog";
import { validateReport, type Cell, type Report } from "./model";
import { cellDeadlines, type DeadlinePolicy } from "./deadlines";
function clean(value: string): string { return value.replace(/[\r\n|]/g, " ").replace(/\s+/g, " ").trim(); }
function concise(error: string): string {
  const terminal = error.indexOf("; terminal: ");
  return clean(terminal >= 0 ? error.slice(terminal + 12) : error).slice(0, 600);
}
function provenance(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("files" in value)) return value;
  const { files, ...metadata } = value;
  return { ...metadata, fileCount: Array.isArray(files) ? files.length : null, inventory: "TABLE.json" };
}
function mark(cell: Cell): string {
  if (cell.status === "pass") return "PASS";
  if (cell.status === "fail") return `FAIL (${cell.phase})`;
  if (cell.status === "pending") return "Pending";
  return "Not runnable yet";
}
export function deadlineMarkdown(policy: DeadlinePolicy): string {
  const lines = ["## Deadlines", "", `Campaign phases: ${policy.timeoutMs} ms by default. Cleanup: ${policy.cleanupTimeoutMs} ms, with existing shorter inner bounds.`, "", "| Framework | Default install in ms | Default build in ms |", "| --- | ---: | ---: |"];
  for (const framework of frameworks) lines.push(`| ${framework.label} | ${policy.installTimeouts[framework.id]} | ${policy.buildTimeouts[framework.id]} |`);
  if (!policy.calibration) return lines.concat([""]).join("\n");
  const metadata = policy.calibration;
  lines.push("", `${metadata.decision}. Decision date: ${metadata.decisionDate}.`);
  if (!("kind" in metadata)) lines.push("", `Historical calibration margin: ${metadata.margin * 100}%. ${metadata.selection}.`, "",
    `Frozen input: ${metadata.source.path}. SHA-256: ${metadata.source.sha256}. Run: ${metadata.source.run}. Recorded: ${metadata.source.createdAt}.`);
  lines.push("", "Limits catch hangs. Actual phase times remain recorded for speed work. Explicit CLI overrides take precedence and are recorded below. Cleanup and inner bounds are unchanged.", "", "```json", JSON.stringify(policy.overrides, null, 2), "```", "",
    "| Framework | Browser | Engine | Phase in ms | Install in ms | Build in ms |", "| --- | --- | --- | ---: | ---: | ---: |");
  for (const framework of frameworks) {
    lines.push(...browsers.flatMap(browser => engines.map(engine => {
      const limits = cellDeadlines(policy, { framework: framework.id, browser, engine });
      return `| ${framework.label} | ${browser} | ${engine} | ${limits.timeoutMs} | ${limits.installTimeoutMs} | ${limits.buildTimeoutMs} |`;
    })));
  }
  return lines.concat([""]).join("\n");
}
export function markdown(report: Report): string {
  validateReport(report);
  const cells = new Map(report.cells.map(cell => [boxId(cell), cell]));
  const lines = ["# Framework matrix", "", `Run ${report.run}. Generated ${report.createdAt}. ${report.cells.length} boxes.`, "", `Source ${report.source.commit}${report.source.dirty ? " with uncommitted changes" : ""}.`, "", "```sh", report.command, "```", "", "PASS requires every phase, including cleanup. Pending is not a result. Native Safari is never Playwright WebKit.", ""];
  lines.push(deadlineMarkdown(report.deadlines));
  for (const browser of browsers) {
    lines.push(`## ${browserLabels[browser]}`, "", "| Framework | " + engines.join(" | ") + " |", "| --- | " + engines.map(() => "---").join(" | ") + " |");
    for (const framework of frameworks) lines.push(`| ${framework.label} | ` + engines.map(engine => {
      const cell = cells.get(boxId({ framework: framework.id, browser, engine }));
      if (!cell) throw new Error("Missing box");
      return mark(cell);
    }).join(" | ") + " |");
    lines.push("");
  }
  lines.push("## Errors and prerequisites", "");
  for (const cell of report.cells) {
    if (cell.status === "pass") continue;
    const error = cell.status === "fail" ? `${cell.phase}: ${cell.error}` : cell.reason;
    lines.push(`- ${boxId(cell)}. ${concise(error)}`);
  }
  lines.push("", "## Provenance", "", "Artifact details, browser capabilities, phase evidence, previous attempts, and discovery are in TABLE.json.", "", "```json", JSON.stringify(provenance(report.source.assets), null, 2), "```", "");
  return lines.join("\n");
}
export async function saveReport(directory: string, report: Report): Promise<void> {
  const text = markdown(report);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "TABLE.json.tmp"), JSON.stringify(report, null, 2) + "\n");
  await rename(join(directory, "TABLE.json.tmp"), join(directory, "TABLE.json"));
  await writeFile(join(directory, "TABLE.md.tmp"), text);
  await rename(join(directory, "TABLE.md.tmp"), join(directory, "TABLE.md"));
}
