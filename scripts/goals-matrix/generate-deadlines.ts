import { readFile, writeFile } from "node:fs/promises";
import { inventory } from "./catalog";
import type { CellLimits, HangCapMetadata } from "./calibration-model";

export const hangCaps: Readonly<CellLimits> = { timeoutMs: 300_000, installTimeoutMs: 600_000, buildTimeoutMs: 600_000 };

export function defaultCellPolicy() {
  const metadata: HangCapMetadata = { kind: "hang-caps", decision: "Working first, speed later: uniform hang caps; actual phase times remain recorded", decisionDate: "2026-11-14" };
  return { metadata, cells: inventory().map(box => ({ ...box, kind: "hang-cap", limits: { ...hangCaps } })) };
}

if (import.meta.main) {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length || (mode !== undefined && mode !== "--check")) throw new Error("Usage: bun scripts/goals-matrix/generate-deadlines.ts [--check]");
  const path = new URL("./cell-deadlines.json", import.meta.url);
  const generated = JSON.stringify(defaultCellPolicy(), null, 2) + "\n";
  if (mode === "--check") {
    if (generated !== await readFile(path, "utf8")) throw new Error("Checked-in hang caps differ; regenerate cell-deadlines.json");
  } else await writeFile(path, generated);
}
