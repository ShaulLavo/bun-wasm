import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProcessOwner, describe, type ProcessIdentity } from "../process-owner.mts";
import { CONSUMERS, RELAY_DECISION, sameSource, sameTuple, type ConsumerHandoff, type ConsumerName, type FileIdentity, type SourceIdentity } from "./contract.ts";
import { bindLoaded, parseLoaded, type LoadedSurface } from "./loaded.ts";
import { admitIntake, buildHandoff, readSealedDelivery, requireHandoffArtifacts } from "./delivery.ts";
import { fileIdentity, sha256 } from "./identity.ts";
import { AdmissionError, authenticate, cleanSource, protectedPaths, type Authenticated, type ParsedRun } from "./inputs.ts";
import { Staging, baseEnvironment, establishEnvironment, stageDonors, type ProductEnvironment } from "./admission.ts";
import { STAGE_DRAIN, runOwned } from "./process.ts";
import { Claimed, ClaimRefused, checkPlan, qualifyPlan, rehearsePlan, runPlan, validatePlan, type RootPlan } from "./roots.ts";
import { STAGES, runStages, type StageContext, type StageIndex } from "./stages.ts";

/** Source root of this controller: it must be the configured, selected source. */
const CONTROLLER_ROOT = resolve(import.meta.dir, "../..");

export interface Cleanup {
  readonly drained: boolean;
  readonly survivors: readonly string[];
  readonly removed: readonly string[];
  /** Kept because owned processes could still be using them. */
  readonly retainedUnsafe: readonly string[];
  /** Owned paths whose removal failed after a proven drain, with the error; they remain on disk. */
  readonly removalFailed: readonly { readonly path: string; readonly error: string }[];
  readonly retained: readonly string[];
  readonly sourceClean: boolean;
}
/** Process drain alone is not successful cleanup. */
export function operationSucceeded(outcome: { readonly error?: unknown; readonly cleanup: Cleanup }): boolean {
  const { cleanup } = outcome;
  return outcome.error === undefined && cleanup.drained && cleanup.sourceClean
    && cleanup.survivors.length === 0 && cleanup.retainedUnsafe.length === 0 && cleanup.removalFailed.length === 0;
}
/** Product outputs a run creates inside the source checkout; registered before any stage runs. */
const PRODUCT_OUTPUTS = ["dist", "web/dist"];

/** One invocation's owned state: roots, staged paths and processes. */
export class Invocation {
  readonly owner = new ProcessOwner();
  readonly claimed = new Claimed();
  staging: Staging | undefined;
  constructor(readonly plan: RootPlan, readonly sourceRoot: string) {}

  /**
   * Drain every owned process, then delete only what nothing can still use.
   * Owned scratch can hold sealed private copies (rehearsal seals its copy
   * 0555), so removal unlocks owned directories first. A failure is recorded
   * and the path kept; it never prevents the cleanup receipt.
   */
  async teardown(drain = STAGE_DRAIN): Promise<Cleanup> {
    const survivors: ProcessIdentity[] = await this.owner.drain(drain);
    const staged = this.staging?.staged ?? [];
    const retained = this.claimed.created.filter(spec => spec.retained).map(spec => spec.path);
    const scratch = this.claimed.created.filter(spec => !spec.retained).map(spec => spec.path);
    if (survivors.length) return { drained: false, survivors: [describe(survivors)], removed: [], retainedUnsafe: staged.concat(scratch), removalFailed: [], retained, sourceClean: false };
    const removed: string[] = [];
    const removalFailed: { path: string; error: string }[] = [];
    for (const path of staged.toReversed().concat(scratch.toReversed())) {
      try { removeOwnedTree(path); removed.push(path); }
      catch (error) { removalFailed.push({ path, error: message(error) }); }
    }
    let sourceClean = true;
    try { cleanSource(this.sourceRoot); } catch { sourceClean = false; }
    return { drained: true, survivors: [], removed, retainedUnsafe: [], removalFailed, retained, sourceClean };
  }
}
/** Make an owned tree's own directories writable (never following links), then remove it. */
function removeOwnedTree(path: string): void {
  const unlock = (directory: string): void => {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) unlock(join(directory, entry.name));
  };
  if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) unlock(path);
  rmSync(path, { recursive: true, force: true });
  if (lstatSync(path, { throwIfNoEntry: false })) throw new AdmissionError(`owned path survived removal: ${path}`);
}

export interface Admitted { readonly authenticated: Authenticated; readonly environment: ProductEnvironment; readonly staging: Staging }
/**
 * The one admission routine for check, run and rehearse: authenticate every
 * input read-only, stage private donor copies at the run's logical paths,
 * then establish E and prove every native, tool and crate fact in it.
 */
async function admit(run: ParsedRun, invocation: Invocation, privateRoot: string, signal: AbortSignal, extra: Readonly<Record<string, string>> = {}): Promise<Admitted> {
  const authenticated = authenticate(run, CONTROLLER_ROOT, join(privateRoot, "admission-git"));
  const staging = new Staging(run.config.sourceRoot, privateRoot);
  invocation.staging = staging;
  await stageDonors(authenticated, staging, invocation.owner, signal);
  for (const path of ["t", "targets", "wasmtime-cache"]) mkdirSync(join(privateRoot, path), { recursive: true });
  const environment = await establishEnvironment(authenticated, staging, baseEnvironment(authenticated, staging, extra), invocation.owner, signal);
  return { authenticated, environment, staging };
}
/** Replace this process's environment with E so in-process captures read exactly what commands receive. */
function publishEnvironment(env: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
}
function write(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function operate<T>(plan: RootPlan, run: ParsedRun, signal: AbortSignal, body: (invocation: Invocation) => Promise<T>, extraProtected: readonly string[] = []): Promise<{ result?: T; error?: unknown; cleanup: Cleanup; record?: string }> {
  validatePlan(plan, protectedPaths(run).concat(extraProtected));
  const invocation = new Invocation(plan, run.config.sourceRoot);
  let result: T | undefined;
  let failure: unknown;
  try {
    invocation.claimed.claim(plan.admission);
    result = await body(invocation);
  } catch (error) { failure = error; }
  const cleanup = await invocation.teardown();
  const record = plan.durable[0] && invocation.claimed.owns(plan.durable[0].name) ? invocation.claimed.path(plan.durable[0].name) : undefined;
  if (record) write(join(record, "cleanup.json"), cleanup);
  if (failure instanceof ClaimRefused && !record) return { error: failure, cleanup };
  return { result, error: failure, cleanup, record };
}

/** Admit everything a run needs, report drafts, and keep nothing. */
export async function check(run: ParsedRun, signal: AbortSignal) {
  const plan = checkPlan(`${run.config.roots.run.private}-check`);
  return operate(plan, run, signal, async invocation => {
    const admitted = await admit(run, invocation, invocation.claimed.path("scratch"), signal);
    return { configSha256: run.configSha256, source: admitted.authenticated.source, drafts: admitted.authenticated.drafts, tools: admitted.environment.tools };
  });
}

/** The exact config and manifest bytes admission parsed, re-read and refused if they changed since. */
function records(run: ParsedRun, admitted: Admitted) {
  const config = readFileSync(run.configPath);
  const inputs = readFileSync(run.config.manifest.path);
  if (sha256(config) !== run.configSha256) throw new AdmissionError("config bytes changed after admission");
  if (sha256(inputs) !== run.config.manifest.sha256 || inputs.byteLength !== run.config.manifest.bytes) throw new AdmissionError("input manifest bytes changed after admission");
  return { config, inputs, environment: Buffer.from(JSON.stringify({ env: admitted.environment.env, tools: admitted.environment.tools }, null, 2) + "\n") };
}
function stageContext(run: ParsedRun, admitted: Admitted, invocation: Invocation, mode: "run" | "rehearse", artifact: string, produced: StageContext["produced"]): StageContext {
  const delivered = records(run, admitted);
  return { mode, source: admitted.authenticated.source, sourceRoot: run.config.sourceRoot, manifest: run.manifest, artifact, report: invocation.claimed.path("report"),
    browserTmp: invocation.claimed.path("browserTmp"), env: admitted.environment.env, owner: invocation.owner, records: delivered, privateRoot: invocation.claimed.path("private"),
    facts: { source: admitted.authenticated.source, tuple: run.manifest.tuple, configSha256: run.configSha256, inputsSha256: sha256(delivered.inputs) },
    produced, drafts: admitted.authenticated.drafts };
}
function registerProductOutputs(admitted: Admitted): void {
  for (const path of PRODUCT_OUTPUTS) admitted.staging.register(join(admitted.staging.sourceRoot, path));
}

/** Production: admission, durable claim (report first), every stage, single seal. Requires the exact config digest. */
export async function produce(run: ParsedRun, executeSha256: string, signal: AbortSignal) {
  if (executeSha256 !== run.configSha256) throw new AdmissionError("--execute must equal the SHA-256 of this config's bytes");
  const plan = runPlan(run.config);
  return operate(plan, run, signal, async invocation => {
    const extra = { BUN_WASM_PRODUCER_REPORT_ROOT: run.config.roots.run.report };
    const admitted = await admit(run, invocation, invocation.claimed.path("private"), signal, extra);
    if (admitted.authenticated.drafts.length) throw new AdmissionError(`inputs are still draft: ${admitted.authenticated.drafts.join("; ")}`);
    invocation.claimed.claim(plan.durable);
    registerProductOutputs(admitted);
    publishEnvironment(admitted.environment.env);
    const context = stageContext(run, admitted, invocation, "run", invocation.claimed.path("artifact"), { source: admitted.authenticated.source, runtime: run.manifest.tuple.runtime });
    for (const path of ["split", "publication"]) mkdirSync(join(context.artifact, path));
    const stages = await runStages(context, STAGES, signal);
    const delivery = fileIdentity(join(context.artifact, "delivery/DELIVERY.json"));
    write(join(context.report, "RESULT.json"), { status: "producer-complete; awaiting-independent-parent-byte-intake", configSha256: run.configSha256, source: context.source,
      tuple: run.manifest.tuple, delivery, parentByteIntake: null, consumerAcceptance: null });
    return { delivery, stages: Object.keys(stages).length };
  });
}

function retainedProduced(root: string): StageContext["produced"] {
  const read = (path: string) => { try { return JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>; } catch { return undefined; } };
  const source = read("split/manifest.json")?.source as SourceIdentity | undefined;
  const metadata = read("publication/inputs/browser-consumer.json")?.metadata as Record<string, unknown> | undefined;
  return { source, runtime: typeof metadata?.version === "string" ? metadata.version : undefined };
}
/** Content and metadata witness of a retained root: every entry's mode and inode, every file's bytes and SHA-256. */
export function treeWitness(root: string, path = ""): string[] {
  return readdirSync(join(root, path)).sort().flatMap(name => {
    const member = path ? `${path}/${name}` : name;
    const stat = lstatSync(join(root, member), { bigint: true });
    const content = stat.isFile() ? fileIdentity(join(root, member)).sha256 : "";
    const line = `${member}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0${stat.ino}\0${content}`;
    return stat.isDirectory() ? [line].concat(treeWitness(root, member)) : [line];
  });
}
/**
 * Rehearse the stage suffix on a private copy of a retained artifact root,
 * in the same admitted environment. Never qualifying, never producer status;
 * the retained original must not change.
 */
export async function rehearse(run: ParsedRun, retained: string, startStage: string | undefined, signal: AbortSignal) {
  const plan = rehearsePlan(run.config);
  const start = startStage ?? "jsc-embedding.log";
  const first = STAGES.findIndex(stage => stage.name === start);
  if (first < 0) throw new AdmissionError(`unknown stage ${start}`);
  if (startStage && STAGES[first]?.eligibility === "production-only") throw new AdmissionError(`${start} is production-only and never runs in rehearsal`);
  const witness = sha256(treeWitness(retained).join("\n"));
  const outcome = await operate(plan, run, signal, async invocation => {
    const admitted = await admit(run, invocation, invocation.claimed.path("private"), signal);
    invocation.claimed.claim(plan.durable);
    registerProductOutputs(admitted);
    publishEnvironment(admitted.environment.env);
    const copy = join(invocation.claimed.path("private"), "retained-copy");
    await runOwned(invocation.owner, { argv: ["/usr/bin/cp", "-r", "--reflink=auto", "--", retained, copy], cwd: "/", env: { PATH: "/usr/bin:/bin" } }, signal);
    // Only this private copy becomes writable; the retained original keeps its seal (witnessed below).
    await runOwned(invocation.owner, { argv: ["/usr/bin/chmod", "-R", "u+w", "--", copy], cwd: "/", env: { PATH: "/usr/bin:/bin" } }, signal);
    const produced = retainedProduced(copy);
    const context = stageContext(run, admitted, invocation, "rehearse", copy, produced);
    const stages: StageIndex = await runStages(context, STAGES.slice(first), signal);
    write(join(context.report, "REHEARSAL.json"), { qualifying: false, producerStatus: null, retained: { path: retained, produced, witnessSha256: witness },
      selected: { source: context.source, tuple: run.manifest.tuple }, drafts: admitted.authenticated.drafts, stages });
    return stages;
  }, [retained]);
  if (sha256(treeWitness(retained).join("\n")) !== witness) throw new AdmissionError(`retained original changed during rehearsal: ${retained}`);
  return outcome;
}

/** Chromium consumers report real response observations; every one must bind to an admitted object. */
function requireLoaded(handoff: ConsumerHandoff, surface: LoadedSurface, result: unknown): void {
  bindLoaded(handoff, surface, parseLoaded(result && typeof result === "object" && "loaded" in result ? result.loaded : undefined));
}
interface DriverRun { argv: string[]; env?: Record<string, string>; out: string; surface?: LoadedSurface }
type Driver = (handoff: ConsumerHandoff, context: { sourceRoot: string; env: Readonly<Record<string, string>>; handoffFile: FileIdentity }) => DriverRun[] | string;
const browserEnv = (handoff: ConsumerHandoff) => ({ TMPDIR: handoff.browserTmp, TMP: handoff.browserTmp, TEMP: handoff.browserTmp });
/** TLS writes its result under the same output directory passed to its CLI. */
export function tlsDriver(handoff: ConsumerHandoff, context: Parameters<Driver>[1]): ReturnType<Driver> {
  if (handoff.dependencies.tls.status === "unresolved") return `TLS dependencies unresolved: ${handoff.dependencies.tls.missing}`;
  if (handoff.fixtures.tls.status === "unresolved") return `TLS fixture options unresolved: ${handoff.fixtures.tls.missing}`;
  const out = join(handoff.outputs.tls, "pg-early");
  return [{ out, surface: "tls", env: browserEnv(handoff), argv: [context.env.BUN_EXE ?? "bun", "scripts/tls-qualification.ts", "--stage", "pg-early", "--browser", "chromium", "--engine", "browser",
    "--handoff", context.handoffFile.path, "--handoff-sha256", context.handoffFile.sha256, "--output", out] }];
}
export function fiveOwnerDriver(handoff: ConsumerHandoff, context: Parameters<Driver>[1]): ReturnType<Driver> {
  if (!existsSync(join(context.sourceRoot, "scripts/io-resource-context.ts"))) return "the selected source has no scripts/io-resource-context.ts driver";
  const bun = context.env.BUN_EXE ?? "bun";
  const out = (name: string) => join(handoff.outputs["five-owner"], name);
  const pinned = ["--handoff", context.handoffFile.path, "--handoff-sha256", context.handoffFile.sha256];
  const native = (engine: "quickjs" | "jsc") => ({ out: out(engine), argv: [bun, "scripts/io-resource-context.ts", "--surface", "native", "--engine", engine]
    .concat(pinned, ["--out", out(engine)]) });
  return [native("quickjs"), native("jsc"), { out: out("chromium"), surface: "web", env: browserEnv(handoff),
    argv: [bun, "scripts/io-resource-context.ts", "--surface", "chromium"].concat(pinned, ["--out", out("chromium")]) }];
}

/** Process completion preserves child evidence; it is never qualification acceptance. */
export function completedConsumerResult(out: string, result: unknown): { out: string; status: "completed"; result: unknown } {
  return { out, status: "completed", result };
}
/** Each consumer's driver, or why it cannot run yet. Consumers only read the handoff. */
const DRIVERS: Readonly<Record<ConsumerName, Driver>> = {
  "five-owner": fiveOwnerDriver,
  // TLS reads everything (delivery, intake, dependencies, fixture options, its sealed page) from the one pinned handoff.
  tls: tlsDriver,
  // No producer gate: Relay owns its conditional post-intake Browser-default WebSocket consumer and its driver inputs.
  relay: () => `not run by the controller: ${RELAY_DECISION.consumer}`,
};

/**
 * After independent intake of this exact sealed delivery, hand its read-only
 * paths to each consumer once. No build runs; every consumer writes only its
 * own output directory. Missing or foreign intake refuses every consumer.
 */
export async function qualify(run: ParsedRun, intakePath: string, intakeSha256: string, signal: AbortSignal) {
  const plan = qualifyPlan(run.config);
  const deliveryRoot = join(run.config.roots.run.artifact, "delivery");
  return operate(plan, run, signal, async invocation => {
    // The sealed CONFIG and INPUTS records are this invocation's exact config and manifest bytes.
    const delivery = readSealedDelivery(deliveryRoot);
    const admitted = admitIntake(intakePath, intakeSha256, delivery);
    if (delivery.manifest.configSha256 !== run.configSha256 || delivery.manifest.inputsSha256 !== run.config.manifest.sha256) throw new AdmissionError("delivery was produced from another config or input manifest");
    const authenticated = authenticate(run, CONTROLLER_ROOT, join(invocation.claimed.path("private"), "admission-git"));
    if (!sameSource(delivery.manifest.source, authenticated.source) || !sameTuple(delivery.manifest.tuple, run.manifest.tuple)) throw new AdmissionError("delivery source or tuple differs from the admitted selection");
    const staging = new Staging(run.config.sourceRoot, invocation.claimed.path("private"));
    invocation.staging = staging;
    await stageDonors(authenticated, staging, invocation.owner, signal);
    mkdirSync(join(invocation.claimed.path("private"), "t"), { recursive: true });
    const environment = await establishEnvironment(authenticated, staging, baseEnvironment(authenticated, staging), invocation.owner, signal);
    invocation.claimed.claim(plan.durable);
    const output = invocation.claimed.path("output");
    const handoff = buildHandoff(delivery, admitted.identity, delivery.inputs.consumers, delivery.config.fixtures, output, invocation.claimed.path("browserTmp"));
    requireHandoffArtifacts(handoff);
    write(join(output, "handoff.json"), handoff);
    const handoffFile = fileIdentity(join(output, "handoff.json"));
    const results: Partial<Record<ConsumerName, unknown>> = {};
    for (const name of CONSUMERS) results[name] = await runConsumer(name, handoff, handoffFile, run, environment, invocation, signal);
    requireHandoffArtifacts(handoff);
    write(join(output, "QUALIFICATION.json"), { delivery: handoff.delivery.manifest, intake: handoff.intake, source: handoff.source, results });
    return results;
  }, [deliveryRoot, intakePath]);
}
async function runConsumer(name: ConsumerName, handoff: ConsumerHandoff, handoffFile: FileIdentity, run: ParsedRun, environment: ProductEnvironment, invocation: Invocation, signal: AbortSignal) {
  const invocations = DRIVERS[name](handoff, { sourceRoot: run.config.sourceRoot, env: environment.env, handoffFile });
  if (typeof invocations === "string") return { status: "not-run", reason: invocations };
  mkdirSync(handoff.outputs[name]);
  const outcomes = [];
  for (const driver of invocations) {
    try {
      await runOwned(invocation.owner, { argv: driver.argv, cwd: run.config.sourceRoot, env: { ...environment.env, ...driver.env } }, signal);
      const result: unknown = JSON.parse(readFileSync(join(driver.out, "result.json"), "utf8"));
      if (driver.surface) requireLoaded(handoff, driver.surface, result);
      if (driver.surface && readdirSync(handoff.browserTmp).length) throw new AdmissionError(`${name} left browser scratch in ${handoff.browserTmp}`);
      outcomes.push(completedConsumerResult(driver.out, result));
    } catch (error) { outcomes.push({ out: driver.out, status: "fail", error: message(error) }); }
  }
  return { status: outcomes.every(outcome => outcome.status === "completed") ? "completed" : "fail", outcomes };
}
