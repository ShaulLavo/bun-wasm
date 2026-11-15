import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, statSync, readSync } from "node:fs";
import { join } from "node:path";
import { expectedBrowserGuestRows, rowIdentity, type BrowserGuestRow, type CoverageLeg, type CoverageEngine, type CoverageOwner } from "./browser-guest-catalogue";

export function browserGuestLeg(value: string | undefined): CoverageLeg {
  if (value !== "chromium" && value !== "webkit") throw new Error("Select exactly one browser: chromium or webkit");
  return value;
}
export type RowEvidence = { readonly id: string; readonly status: "passed" | "failed" | "not-run"; readonly detail: string };
type Cleanup = { readonly kind: "drained" } | { readonly kind: "unsafe"; readonly error: string };
interface ChildResult {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly elapsedMs: number;
  readonly cancelled: boolean;
  readonly cleanup: Cleanup;
  readonly log: string;
}
type RowRecord = { readonly id: string; readonly status: "planned" } | RowEvidence & {
  readonly command: readonly string[]; readonly elapsedMs: number; readonly cleanup: Cleanup;
};
interface ChildRequest {
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly rows: readonly BrowserGuestRow[];
  readonly hangSeconds?: 900 | 1400;
  readonly signal?: AbortSignal;
  /** Read the driver's complete success markers/structured report, never infer rows from exit alone. */
  readonly evidence: (result: ChildResult) => readonly RowEvidence[] | Promise<readonly RowEvidence[]>;
}
const supervisor = new URL("./run-with-timeout.mts", import.meta.url).pathname;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function persist(path: string, value: unknown): void {
  writeFileSync(path + ".tmp", JSON.stringify(value, null, 2) + "\n");
  renameSync(path + ".tmp", path);
}
function completion(state: string, exitCode: number): Cleanup {
  try {
    const value = readFileSync(join(state, "status"), "utf8");
    if (value !== `${exitCode}\n`) throw new Error("Supervisor status disagrees with exit");
    return { kind: "drained" };
  } catch (error) { return { kind: "unsafe", error: message(error) }; }
}
function retainTail(path: string): void {
  const bytes = statSync(path).size;
  if (bytes <= 65_536) return;
  const tail = Buffer.alloc(65_536), fd = openSync(path, "r");
  try { readSync(fd, tail, 0, tail.length, bytes - tail.length); }
  finally { closeSync(fd); }
  writeFileSync(path, tail);
}

/** One matrix owner/leg. Construct before launch to persist the complete planned set. */
export class BrowserGuestRegression {
  readonly expected: readonly BrowserGuestRow[];
  private readonly rows = new Map<string, RowRecord>();
  private readonly children: ChildResult[] = [];
  private readonly failures: string[] = [];
  private readonly controls = new Map<string, RowEvidence>();
  private active = false;
  private finished = false;
  private unsafe = false;

  constructor(private readonly request: { owner: CoverageOwner; leg: CoverageLeg; engines: readonly CoverageEngine[]; directory: string;
    controls: readonly string[] }) {
    this.expected = expectedBrowserGuestRows([{ owner: request.owner, engines: request.engines }], request.leg);
    if (!this.expected.length || new Set(request.controls).size !== request.controls.length) throw new Error("Invalid expected rows/controls");
    mkdirSync(request.directory, { recursive: true });
    for (const row of this.expected) this.rows.set(rowIdentity(row), { id: rowIdentity(row), status: "planned" });
    this.save();
  }
  get safeToReuse(): boolean { return !this.active && !this.unsafe; }
  private save(): void {
    persist(join(this.request.directory, "rows.json"), { expected: this.expected, rows: Array.from(this.rows.values()),
      expectedControls: this.request.controls, controls: Array.from(this.controls.values()), children: this.children, failures: this.failures });
  }
  recordControl(evidence: RowEvidence): void {
    if (!this.request.controls.includes(evidence.id) || this.controls.has(evidence.id) || this.finished) throw new Error(`Unexpected/duplicate control: ${evidence.id}`);
    this.controls.set(evidence.id, evidence);
    this.save();
  }
  private checkChild(request: ChildRequest): void {
    if (this.active || this.unsafe || this.finished) throw new Error("Cannot launch before safe child drain or after finalization");
    if (!request.rows.length || new Set(request.rows.map(rowIdentity)).size !== request.rows.length) throw new Error("Child must own a nonempty unique row subset");
    for (const row of request.rows) {
      if (this.rows.get(rowIdentity(row))?.status !== "planned") throw new Error(`Unselected or already run row: ${rowIdentity(row)}`);
    }
  }
  async runChild(request: ChildRequest): Promise<ChildResult> {
    this.checkChild(request);
    this.active = true;
    let result: ChildResult | undefined;
    try {
      result = await supervise(request, this.request.directory, this.children.length);
      this.children.push(result);
      this.unsafe ||= result.cleanup.kind === "unsafe";
      await this.recordChild(request, result);
    } catch (error) {
      if (!result) this.unsafe = true;
      this.failures.push(message(error));
      throw error;
    } finally {
      this.active = false;
      try { if (result?.cleanup.kind === "drained") retainTail(result.log); }
      catch (error) { this.failures.push(`Failure log retention: ${message(error)}`); }
      this.save();
    }
    return result;
  }
  private async recordChild(request: ChildRequest, result: ChildResult): Promise<void> {
    const evidence = await request.evidence(result);
    const expected = request.rows.map(rowIdentity);
    const seen = new Set<string>();
    for (const row of evidence) {
      if (!expected.includes(row.id) || seen.has(row.id)) throw new Error(`Unexpected/duplicate child row: ${row.id}`);
      seen.add(row.id);
      if (!["passed", "failed", "not-run"].includes(row.status)) throw new Error(`Invalid row outcome: ${row.id}`);
      const status = result.exitCode !== 0 || result.cancelled || result.cleanup.kind === "unsafe" ? "failed" : row.status;
      this.rows.set(row.id, { ...row, status, command: result.command, elapsedMs: result.elapsedMs, cleanup: result.cleanup });
    }
    for (const id of expected.filter(id => !seen.has(id))) this.rows.set(id, { id, status: "not-run", detail: "Driver supplied no row evidence", command: result.command, elapsedMs: result.elapsedMs, cleanup: result.cleanup });
  }
  /** Call from finally, including after assertions/cancellation; never treat missing rows as skips. */
  finish(): void {
    if (this.active) throw new Error("Cannot finalize while a child is active");
    if (this.finished) throw new Error("Coverage already finalized");
    this.finished = true;
    for (const [id, row] of this.rows) {
      if (row.status !== "planned") continue;
      this.rows.set(id, { id, status: "not-run", detail: "Selected row was never launched", command: [], elapsedMs: 0,
        cleanup: this.unsafe ? { kind: "unsafe", error: "Prior child drain was not proven" } : { kind: "drained" } });
    }
    const incomplete = Array.from(this.rows.values()).filter(row => row.status !== "passed").map(row => row.id);
    const controls = this.request.controls.filter(id => this.controls.get(id)?.status !== "passed");
    this.save();
    const errors = this.failures.concat(incomplete.map(id => `Required row did not pass: ${id}`), controls.map(id => `Required control did not pass: ${id}`));
    if (this.unsafe) errors.push("Unsafe child cleanup stopped reuse");
    if (errors.length) throw new AggregateError(errors.map(error => new Error(error)), "Browser guest coverage failed");
  }
}

async function supervise(request: ChildRequest, directory: string, index: number): Promise<ChildResult> {
  if (process.platform !== "linux") throw new Error("Browser coverage child cleanup receipts require Linux");
  const state = join(directory, `child-${index}`), log = join(directory, `child-${index}.log`);
  mkdirSync(state);
  const fd = openSync(log, "wx"), started = performance.now();
  let cancelled = request.signal?.aborted ?? false;
  const stop = () => { cancelled = true; writeFileSync(join(state, "stop"), "stop\n"); };
  // Cancellation is registered before the supervisor or any descendants can exist.
  request.signal?.addEventListener("abort", stop, { once: true });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, stop);
  try {
    if (cancelled) stop();
    const child = spawn(process.execPath, [supervisor, "--state", state, String(request.hangSeconds ?? 900)].concat(request.command), { cwd: request.cwd, env: request.env, stdio: ["ignore", fd, fd] });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGTERM" ? 143 : 1)));
    });
    return { command: request.command, exitCode, elapsedMs: performance.now() - started, cancelled, cleanup: completion(state, exitCode), log };
  } finally {
    closeSync(fd);
    request.signal?.removeEventListener("abort", stop);
    for (const signal of signals) process.off(signal, stop);
  }
}
