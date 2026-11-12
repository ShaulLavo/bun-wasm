import assert from "node:assert/strict";
import { HarnessCleanupError } from "./cleanup.ts";
import { childEnvironment, labelsForHost, williamsSchedule, type ArmDescriptor, type ArmRegistry, type MeasurementHost } from "../engine-arm-registry.ts";

export function censusArms(registry: ArmRegistry, host: MeasurementHost): readonly ArmDescriptor[] {
  return host === "native" ? registry.nativeArms : registry.chromiumArms;
}

export function censusChild(arm: ArmDescriptor, host: MeasurementHost, inherited: NodeJS.ProcessEnv) {
  assert.ok(labelsForHost(host).includes(arm.label), "Browser is unavailable natively");
  return { label: arm.label, engine: arm.engineKind, program: arm.program, servedGzip: arm.servedGzip, producerAdmission: arm.producerAdmission, environment: childEnvironment(arm, inherited),
    sourceCommit: arm.sourceCommit, sourceTree: arm.sourceTree, tier: arm.tier, cacheIdentity: arm.label };
}

export function verifyCensusProvenance(provenance: Record<string, unknown>, registry: ArmRegistry, arm: ArmDescriptor): void {
  assert.equal(provenance.sourceCommit, registry.sourceCommit, "mixed-source census report");
  assert.equal(provenance.sourceTree, registry.sourceTree, "mixed-tree census report");
  assert.equal(provenance.armLabel, arm.label, "census arm label differs");
  assert.equal(provenance.engineKind, arm.engineKind, "census engine differs");
  assert.equal(provenance.tier, arm.tier, "census tier differs");
  assert.deepEqual(provenance.program, arm.program, "census program bytes differ");
  assert.deepEqual(provenance.servedGzip, arm.servedGzip, "census served bytes differ");
  assert.deepEqual(provenance.producerAdmission, arm.producerAdmission, "census admission identities differ");
  assert.equal(provenance.manifestSha256, arm.producerAdmission.manifest.sha256, "census generation differs");
  assert.equal(provenance.admissionSha256, arm.producerAdmission.receipt.sha256, "census admission differs");
  assert.equal(provenance.launcher_sha256, registry.launcher.sha256, "census launcher differs");
}

interface ChromiumMeasurement {
  readonly wallMs: number;
  // A direct compile-phase measurement from the host, not page-to-ready time.
  readonly compileMs: number | null;
}
export interface ChromiumContext {
  measure(workload: string): Promise<ChromiumMeasurement>;
  close(): Promise<void>;
}
export interface ChromiumDriver {
  open(child: ReturnType<typeof censusChild>): Promise<ChromiumContext>;
}

export interface ChromiumSample {
  readonly engine: ArmDescriptor["label"];
  readonly round: number;
  readonly workload: string;
  readonly status: "pass" | "fail" | "blocked";
  readonly wallMs: number | null;
  readonly compileMs: number | null;
  readonly error: string | null;
}
export class ChromiumScheduleError extends Error {
  readonly samples: readonly ChromiumSample[];
  readonly cleanupError: string;
  constructor(samples: readonly ChromiumSample[], cleanupError: string) {
    super(`Chromium context cleanup unconfirmed: ${cleanupError}`);
    this.name = "ChromiumScheduleError";
    this.samples = samples;
    this.cleanupError = cleanupError;
  }
}
function* chromiumSchedule(registry: ArmRegistry) {
  const block = williamsSchedule(registry.chromiumArms);
  for (let round = 0; round < registry.chromiumRounds; round++) {
    for (const arm of block[round % block.length]!) yield { arm, round };
  }
}
function blockedCell(arm: ArmDescriptor, round: number, workload: string, error: string): ChromiumSample {
  return { engine: arm.label, round, workload, status: "blocked", wallMs: null, compileMs: null, error };
}

function blockedWorkloads(arm: ArmDescriptor, round: number, workloads: readonly string[], error: string): ChromiumSample[] {
  return workloads.map(workload => blockedCell(arm, round, workload, error));
}

// Context creation owns the arm's environment before its first worker starts.
// Unconfirmed cleanup stops the schedule and carries every registered cell.
export async function runChromiumSchedule(registry: ArmRegistry, workloads: readonly string[], driver: ChromiumDriver,
  options: { readonly cleanupTimeoutMs: number; readonly signal?: AbortSignal; readonly checkpoint?: (samples: readonly ChromiumSample[]) => Promise<void> } = { cleanupTimeoutMs: 5_000 }): Promise<ChromiumSample[]> {
  assert.ok(workloads.length && new Set(workloads).size === workloads.length, "choose distinct workloads");
  assert.ok(Number.isSafeInteger(options.cleanupTimeoutMs) && options.cleanupTimeoutMs > 0, "cleanup deadline must be positive");
  const schedule = Array.from(chromiumSchedule(registry));
  const samples: ChromiumSample[] = [];
  for (const [index, { arm, round }] of schedule.entries()) {
    if (options.signal?.aborted) {
      const remaining = schedule.slice(index).flatMap(cell => blockedWorkloads(cell.arm, cell.round, workloads, `Interrupted: ${String(options.signal?.reason)}`));
      const interrupted = samples.concat(remaining);
      await options.checkpoint?.(interrupted);
      return interrupted;
    }
    const attempt = await measureChromiumArm(arm, round, workloads, driver, options.cleanupTimeoutMs,
      async rows => { await options.checkpoint?.(samples.concat(rows)); });
    for (const row of attempt.rows) samples.push(row);
    await options.checkpoint?.(samples);
    if (attempt.cleanupError === null) continue;
    const error = `Unattempted after unconfirmed cleanup: ${attempt.cleanupError}`;
    const remaining = schedule.slice(index + 1).flatMap(cell => blockedWorkloads(cell.arm, cell.round, workloads, error));
    throw new ChromiumScheduleError(samples.concat(remaining), attempt.cleanupError);
  }
  return samples;
}
async function closeChromiumContext(context: ChromiumContext, timeoutMs: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([context.close(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(reject, timeoutMs, new Error("Chromium context cleanup timed out"));
    })]);
    return null;
  } catch (error) {
    return String(error);
  } finally { clearTimeout(timer); }
}
async function measureChromiumArm(arm: ArmDescriptor, round: number, workloads: readonly string[], driver: ChromiumDriver, timeoutMs: number, checkpoint: (rows: readonly ChromiumSample[]) => Promise<void>) {
  const rows: ChromiumSample[] = [];
  let context: ChromiumContext;
  try { context = await driver.open(censusChild(arm, "chromium", {})); }
  catch (error) {
    return { rows: blockedWorkloads(arm, round, workloads, String(error)), cleanupError: error instanceof HarnessCleanupError ? String(error) : null };
  }
  let cleanupError: string | null = null;
  try {
    for (const workload of workloads) {
      rows.push(await chromiumCell(context, arm.label, round, workload));
      await checkpoint(rows);
    }
  } finally { cleanupError = await closeChromiumContext(context, timeoutMs); }
  return { rows, cleanupError };
}

async function chromiumCell(context: ChromiumContext, engine: ArmDescriptor["label"], round: number, workload: string): Promise<ChromiumSample> {
  try {
    const timing = await context.measure(workload);
    assert.ok(Number.isFinite(timing.wallMs) && timing.wallMs >= 0, "invalid wall duration");
    assert.ok(timing.compileMs === null || Number.isFinite(timing.compileMs) && timing.compileMs >= 0, "invalid compile duration");
    return { engine, round, workload, status: "pass", ...timing, error: null };
  } catch (error) {
    return { engine, round, workload, status: "fail", wallMs: null, compileMs: null, error: String(error) };
  }
}
