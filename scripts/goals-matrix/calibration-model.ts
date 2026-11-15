export interface CellLimits { timeoutMs: number; installTimeoutMs: number; buildTimeoutMs: number }
export interface HangCapMetadata {
  kind: "hang-caps";
  decision: string;
  decisionDate: string;
}
interface MeasuredMetadata {
  decision: string;
  decisionDate: string;
  margin: number;
  selection: string;
  source: { path: string; sha256: string; run: string; createdAt: string };
}
export type CalibrationMetadata = HangCapMetadata | MeasuredMetadata;
