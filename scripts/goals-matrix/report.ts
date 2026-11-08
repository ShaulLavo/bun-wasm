import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browsers, browserLabels, engines, frameworks, boxId } from "./catalog";
import { validateReport, type Cell, type Report } from "./model";
function clean(value: string): string { return value.replace(/[\r\n|]/g, " ").replace(/\s+/g, " ").trim(); }
function mark(cell: Cell): string {
  if (cell.status === "pass") return "PASS";
  if (cell.status === "fail") return `FAIL (${cell.phase})`;
  if (cell.status === "pending") return "Pending";
  return "Not runnable yet";
}
export function markdown(report: Report): string {
  validateReport(report);
  const cells = new Map(report.cells.map(cell => [boxId(cell), cell]));
  const lines = ["# Framework matrix", "", `Run ${report.run}. Generated ${report.createdAt}. ${report.cells.length} boxes.`, "", `Source ${report.source.commit}${report.source.dirty ? " with uncommitted changes" : ""}.`, "", "```sh", report.command, "```", "", "PASS requires every phase, including cleanup. Pending is not a result. Native Safari is never Playwright WebKit.", ""];
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
    lines.push(`- ${boxId(cell)}. ${clean(error)}`);
  }
  lines.push("", "## Provenance", "", "Artifact details, browser capabilities, phase evidence, previous attempts, and discovery are in TABLE.json.", "", "```json", JSON.stringify(report.source.assets, null, 2), "```", "");
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
