import type { Box } from "./catalog";

export interface CellLimits { timeoutMs: number; installTimeoutMs: number; buildTimeoutMs: number }
export interface CalibrationMetadata {
  decision: string;
  decisionDate: string;
  margin: number;
  selection: string;
  source: { path: string; sha256: string; run: string; createdAt: string };
}
export type CalibrationCell = Box & { limits: CellLimits } & (
  | { kind: "no-complete-pass" | "exempt-next-spidermonkey" }
  | { kind: "calibrated"; measured: CellLimits; attempt: {
    location: string; sourceReport: string; sourceCreatedAt: string;
    startedAt: string; finishedAt: string; sha256: string;
  } }
);
export interface Calibration { metadata: CalibrationMetadata; cells: CalibrationCell[]; startupTimeouts?: Record<string, number> }
