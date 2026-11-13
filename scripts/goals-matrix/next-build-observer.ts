import type { ScopedTransport } from "./transport";
import { admit, type Admission } from "./scope";
import type { ForegroundObservation } from "./playground";
import type { NextBuildCapture } from "./next-build-browser";
import { compareBuildFiles, parseBuildFile, record, type ParsedFile } from "./next-build-files";

declare const __GOALS_NEXT_BUILD_READER__: string;
let source: Promise<string> | undefined;
declare const playground: { term: { buffer: { active: { length: number; getLine(index: number): { translateToString(trim: boolean): string } | undefined } } } };
export type NextBuildObservation =
  | { kind: "baseline" | "snapshot"; at: number; deadline: number; status: "unavailable"; reason: string }
  | { kind: "snapshot"; at: number; deadline: number; status: "skipped"; reason: "Command completed before snapshot dispatch" }
  | { kind: "baseline" | "snapshot"; at: number; deadline: number; status: "captured"; files: ReturnType<typeof compareBuildFiles>; memory: NextBuildCapture["memory"]; processes: NextBuildCapture["processes"] }
  | { kind: "milestone"; at: number; milestone: string; timing: "first observed by foreground poll" }
  | { kind: "milestones"; at: number; status: "unavailable"; reason: string }
  | { kind: "end"; at: number; snapshot: "attempted" | "not reached while command pending" }
  | ({ kind: "cleanup"; at: number } & ({ status: "closed" } | { status: "unavailable"; reason: string }));
export function retainNextBuildObservation(save: (value: NextBuildObservation) => void, value: NextBuildObservation): void {
  try { save(value); }
  catch (error) { process.stderr.write(`Next build observation could not be retained: ${String(error)}\n`); }
}
export async function buildNextBuildReaderSource(): Promise<string> {
  const result = await Bun.build({ entrypoints: [new URL("./next-build-browser.ts", import.meta.url).pathname], target: "browser", format: "iife", minify: true });
  if (!result.success || !result.outputs[0]) throw new AggregateError(result.logs, "Cannot build Next observation reader");
  return result.outputs[0].text();
}
function milestones(): { label: string; count: number }[] {
  const buffer = playground.term.buffer.active;
  const text = Array.from({ length: Math.min(400, buffer.length) }, (_, index) => buffer.getLine(Math.max(0, buffer.length - 400) + index)?.translateToString(true) ?? "").join("\n");
  return ["Compiled successfully", "Collecting page data", "Generating static pages", "Collecting build traces", "Finalizing page optimization"].map(label => ({ label, count: text.split(label).length - 1 }));
}
/** Next policy only; the existing foreground loop calls pending, with the build's original Admission. */
export class NextBuildObserver implements ForegroundObservation {
  readonly expression = `(${milestones.toString()})()`;
  private baseline: ParsedFile[] = [];
  private dispatchedAt = Number.POSITIVE_INFINITY;
  private attempted = false;
  private milestonesUnavailable = false;
  private readonly seen = new Map<string, number>();
  private readonly snapshotAt: number;
  constructor(private readonly page: ScopedTransport, private readonly admission: Admission, phaseTimeoutMs: number,
    private readonly save: (value: NextBuildObservation) => void,
    private readonly timing = { snapshotMs: 100_000, readBudgetMs: 2000 }) {
    this.snapshotAt = admission.deadline - phaseTimeoutMs + timing.snapshotMs;
  }
  async prepare(): Promise<void> {
    source ??= typeof __GOALS_NEXT_BUILD_READER__ === "string" ? Promise.resolve(__GOALS_NEXT_BUILD_READER__) : buildNextBuildReaderSource();
    await this.capture("baseline");
    // Baseline terminal labels belong to dev and are not production milestones.
    try { this.labels(await this.page.evaluate<unknown>(this.expression), false); }
    catch (error) { this.labels({ unavailable: String(error) }, false); admit(this.admission); }
  }
  dispatched(at: number): void { this.dispatchedAt = at; }
  async pending(value: unknown): Promise<boolean> {
    admit(this.admission);
    this.labels(value, true);
    if (this.attempted || Date.now() < this.snapshotAt) return false;
    this.attempted = true;
    await this.capture("snapshot");
    return true;
  }
  end(): void { this.emit({ kind: "end", at: Date.now(), snapshot: this.attempted ? "attempted" : "not reached while command pending" }); }
  private emit(value: NextBuildObservation): void { retainNextBuildObservation(this.save, value); }
  private labels(value: unknown, retain: boolean): void {
    if (!Array.isArray(value)) {
      const failure = record(value)?.unavailable;
      if (!this.milestonesUnavailable) this.emit({ kind: "milestones", at: Date.now(), status: "unavailable", reason: typeof failure === "string" ? failure.slice(0, 1000) : "Unexpected terminal milestone shape" });
      this.milestonesUnavailable = true;
      return;
    }
    for (const item of value) {
      const milestone = record(item);
      if (typeof milestone?.label === "string" && typeof milestone.count === "number") this.label({ label: milestone.label, count: milestone.count }, retain);
    }
  }
  private label(milestone: { label: string; count: number }, retain: boolean): void {
    if (milestone.count <= (this.seen.get(milestone.label) ?? 0)) return;
    this.seen.set(milestone.label, milestone.count);
    if (retain) this.emit({ kind: "milestone", at: Date.now(), milestone: milestone.label, timing: "first observed by foreground poll" });
  }
  private async capture(kind: "baseline" | "snapshot"): Promise<void> {
    const at = Date.now();
    const deadline = Math.min(this.admission.deadline, at + this.timing.readBudgetMs);
    try {
      const script = await source;
      admit(this.admission);
      const capture = await this.page.evaluate<NextBuildCapture | "command-completed">(`(() => { if (${kind === "snapshot"} && globalThis.__goalsCommand?.done) return "command-completed"; ${script}\nconst read = globalThis.__goalsNextBuildRead; delete globalThis.__goalsNextBuildRead; return read(${deadline}); })()`);
      admit(this.admission);
      if (capture === "command-completed") { this.emit({ kind: "snapshot", at, deadline, status: "skipped", reason: "Command completed before snapshot dispatch" }); return; }
      const files = capture.files.map(parseBuildFile);
      const comparison = compareBuildFiles(this.baseline, files, this.dispatchedAt);
      if (kind === "baseline") this.baseline = files;
      this.emit({ kind, at: capture.at, deadline, status: "captured", files: comparison, memory: capture.memory, processes: capture.processes });
    } catch (error) {
      this.emit({ kind, at, deadline, status: "unavailable", reason: String(error) });
      admit(this.admission);
    }
  }
}
/** Runs under the existing cleanup admission; never starts a read or submits a guest command. */
export async function closeNextBuildObserver(page: ScopedTransport): Promise<Extract<NextBuildObservation, { kind: "cleanup" }>> {
  try {
    await page.useHost();
    await page.evaluate("globalThis.__goalsNextBuildClose?.(); delete globalThis.__goalsNextBuildClose; delete globalThis.__goalsNextBuildRead;");
    return { kind: "cleanup", at: Date.now(), status: "closed" };
  } catch (error) { return { kind: "cleanup", at: Date.now(), status: "unavailable", reason: String(error) }; }
}
