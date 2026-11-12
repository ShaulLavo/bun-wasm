import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { baseMatrix } from "./lifecycle-model";
import { array, object, string } from "./input";

export async function summarizeLifecycle(output: string, sources: ReadonlyMap<string, string> = new Map()): Promise<void> {
  const rows = [];
  for (const cell of baseMatrix()) {
    const file = sources.get(cell.id) ?? join(output, cell.id, "run.json");
    const bytes = await readFile(file, "utf8").catch(() => null);
    if (bytes === null) { rows.push({ id: cell.id, status: "pending", milliseconds: null, timingValid: false, headlineEligible: false }); continue; }
    const run = object(JSON.parse(bytes));
    const outcome = object(run.workloadOutcome);
    const result = run.result === null ? null : object(run.result);
    const timing = run.timing === undefined ? null : object(run.timing);
    const verificationPath = typeof timing?.hostVerification === "string" ? timing.hostVerification : join(dirname(dirname(file)), "host-verification.json");
    const verification = await readFile(verificationPath, "utf8").then(text => object(JSON.parse(text))).catch(() => null);
    const valid = timing?.valid === true && verification?.valid === true && outcome.status === "pass" && result !== null && object(result.inputs).valid === true && object(run.observation).kind === "timing";
    rows.push({ id: cell.id, status: outcome.status, milliseconds: result?.wallMs ?? null, timingValid: valid, headlineEligible: false, reason: outcome.reason ?? null,
      hostVerification: verification?.valid ?? null, verificationReason: verification?.reason ?? (verification === null ? "Host verification unavailable" : null), file });
  }
  await writeFile(join(output, "summary.json"), JSON.stringify({ schema: 1, scope: "One nonquiet experimental sweep; no paired or headline claim", rows }, null, 2) + "\n");
  const table = ["# Framework lifecycle matrix", "", "Nonquiet PC experiments. Headless browser timings are ineligible for headline claims.", "", "| Run | Outcome | Observed ms | Timing valid |", "| --- | --- | ---: | --- |"];
  for (const row of rows) table.push(`| ${row.id} | ${row.status} | ${row.milliseconds ?? "unavailable"} | ${row.timingValid} |`);
  await writeFile(join(output, "SUMMARY.md"), table.join("\n") + "\n");
}
if (import.meta.main) {
  const [output, manifest] = process.argv.slice(2);
  if (!output || !manifest) throw new Error("Usage: lifecycle-summary.ts OUTPUT RUN-LIST.json");
  const sources = new Map(array(JSON.parse(await readFile(manifest, "utf8"))).map(value => {
    const run = object(value);
    return [string(run.id), string(run.record)];
  }));
  await summarizeLifecycle(output, sources);
}
