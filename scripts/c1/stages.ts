import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { verifyGuestBuildReceipt } from "../guest-build-receipt.ts";
import { producerLauncherReceiptPath, publicationGuestPaths, verifyLauncher } from "../producer-closure.ts";
import type { DrainTimes } from "../process-owner.mts";
import { sameSource, type SourceIdentity } from "./contract.ts";
import type { SealFacts } from "./delivery.ts";
import { NATIVE_ENTRY } from "./admission.ts";
import { STAGE_DRAIN, runOwned } from "./process.ts";
import type { PublicationContext } from "./publication.ts";
import { serializeContext } from "./step.ts";
import type { StepName } from "./steps.ts";

/**
 * Who may run a stage. Production-only stages build or create production
 * records and never run in rehearsal. Validated-retained stages consume
 * produced bytes and run in rehearsal only when every byte they consume
 * validates against the selected source. Generic stages exercise copying,
 * restaging and sealing mechanics and may run on any private copy; running
 * one never validates anything.
 */
type Eligibility = "production-only" | "validated-retained" | "generic-rehearsal";
interface Command { readonly argv: readonly string[]; readonly overlay?: Readonly<Record<string, string>> }
/**
 * A command runs in E plus its overlay. A step is a named export of a step
 * module; it too runs as an owned child process (scripts/c1/step.ts), so
 * abort drains it exactly like a command.
 */
type Action =
  | { readonly kind: "command"; readonly command: (context: StageContext) => Command }
  | { readonly kind: "step"; readonly module: string; readonly name: string };
/** A produced artifact a stage reads: the stage that makes it, and how a retained copy is validated. */
interface ArtifactRequirement {
  readonly path: string;
  readonly from: string;
  readonly validate?: (context: StageContext, path: string) => void;
}
export interface Stage {
  readonly name: string;
  readonly eligibility: Eligibility;
  readonly needs: readonly ArtifactRequirement[];
  /** Launches Chromium: TMPDIR is the short browser root, which must be empty afterwards. */
  readonly browser?: boolean;
  /** Reads original native inputs, which must all be admitted (no draft). */
  readonly native?: boolean;
  readonly action: Action;
}
export interface StageContext extends PublicationContext {
  readonly mode: "run" | "rehearse";
  readonly privateRoot: string;
  readonly facts: SealFacts;
  /** Source and runtime the artifact bytes claim to come from. Requirements still validate every consumed byte. */
  readonly produced: { readonly source: SourceIdentity | undefined; readonly runtime: string | undefined };
  readonly drafts: readonly string[];
}

const STEPS_MODULE = join(import.meta.dir, "steps.ts");
const STEP_RUNNER = join(import.meta.dir, "step.ts");
const bun = (context: StageContext) => context.env.BUN_EXE ?? "bun";
const engineRoot = (context: StageContext) => join(context.artifact, "split");
/** CI's source-cache Browser recipe: its own target directory, receipt inputs and features. */
const SOURCE_CACHE = `set -euo pipefail
export WASI_SDK="$WASI_SDK_PATH" CARGO_TARGET_DIR="$1"
eval "$("$BUN_EXE" scripts/guest-build-receipt.ts environment)"
"$BUN_EXE" scripts/guest-build-receipt.ts inputs source-cache-browser > "$2"
"$GUEST_CARGO" build --release --locked -j "$CARGO_BUILD_JOBS" --target wasm32-wasip1 -p bunwasm-cli --no-default-features --features engine-host,bun-build
mkdir -p "$(dirname "$3")"
cp "$CARGO_TARGET_DIR/wasm32-wasip1/release/bun.wasm" "$3"
"$BUN_EXE" scripts/guest-build-receipt.ts write "$3" "$2"
`;
const command = (make: (context: StageContext) => Command): Action => ({ kind: "command", command: make });
const step = (name: StepName): Action => ({ kind: "step", module: STEPS_MODULE, name });
/** The same maintained native entry preclaim admission runs; jsc/common.sh keeps it read-only. */
const native = command(() => ({ argv: ["/usr/bin/bash", "-c", NATIVE_ENTRY] }));

/** A retained guest must carry a valid receipt from the selected source. */
function guestReceipt(context: StageContext, path: string): void {
  const receipt: unknown = JSON.parse(readFileSync(`${path}.build.json`, "utf8"));
  verifyGuestBuildReceipt(readFileSync(path), receipt);
  if (!sameSource(receipt.sourceManifest.source, context.source)) throw new Error(`retained guest ${path} was built from another source`);
}
/** A retained split manifest must name the selected source. */
function splitManifest(context: StageContext, path: string): void {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const source = value && typeof value === "object" && "source" in value ? value.source as SourceIdentity : undefined;
  if (!source || !sameSource(source, context.source)) throw new Error(`retained split manifest ${path} names another source`);
}
/** A retained launcher must match its original receipt for the selected source. */
function launcherReceipt(context: StageContext, path: string): void {
  verifyLauncher(path, JSON.parse(readFileSync(join(engineRoot(context), producerLauncherReceiptPath), "utf8")), context.source);
}
const SPLIT_GUESTS: readonly ArtifactRequirement[] = [
  { path: "split/manifest.json", from: "split-producer.log", validate: splitManifest }, { path: "split/launcher/bun-wasm", from: "split-producer.log", validate: launcherReceipt },
  { path: "split/dist/bun.wasm", from: "split-producer.log", validate: guestReceipt }, { path: "split/dist/bun-jsc.wasm", from: "split-producer.log", validate: guestReceipt },
];
const guest = (path: string, from: string): ArtifactRequirement => ({ path: `publication/${path}`, from, validate: guestReceipt });
const PUBLICATION_GUESTS: readonly ArtifactRequirement[] = [guest(publicationGuestPaths.browser, "browser-stage.log"),
  guest(publicationGuestPaths["source-cache-browser"], "source-cache-browser-producer.log"), guest(publicationGuestPaths.tools, "tools-stage.log")];
const SMOKE_GUESTS = SPLIT_GUESTS.concat(PUBLICATION_GUESTS);
/** The matrix's own copies, made by the generic smoke stage, revalidated by their receipts. */
const MATRIX_GUESTS = ["bun-browser.wasm", "bun.wasm", "bun-jsc.wasm"].map((name): ArtifactRequirement => ({ path: `publication-matrix/${name}`, from: "publication-matrix-inputs.log", validate: guestReceipt }));

/** The one production sequence. Rehearsal selects a suffix of these same definitions. */
export const STAGES: readonly Stage[] = [
  { name: "native-before.log", eligibility: "validated-retained", needs: [], native: true, action: native },
  { name: "publication-initialize.log", eligibility: "production-only", needs: [], action: step("initialize") },
  { name: "capture-before.log", eligibility: "production-only", needs: [], action: step("captureBefore") },
  { name: "browser-producer.log", eligibility: "production-only", needs: [], action: command(() => ({ argv: ["/usr/bin/bash", "scripts/build-bun-browser.sh"] })) },
  { name: "browser-stage.log", eligibility: "production-only", needs: [], action: step("stageBrowser") },
  { name: "source-cache-browser-producer.log", eligibility: "production-only", needs: [], action: command(context => ({ argv: ["/usr/bin/bash", "-c", SOURCE_CACHE, "source-cache-browser",
    join(context.privateRoot, "targets/source-cache-browser"), join(context.privateRoot, "source-cache-browser-inputs.json"), join(context.artifact, "publication", publicationGuestPaths["source-cache-browser"])] })) },
  { name: "tools-producer.log", eligibility: "production-only", needs: [], action: command(() => ({ argv: ["/usr/bin/bash", "scripts/build-bun-tools.sh"] })) },
  { name: "tools-stage.log", eligibility: "production-only", needs: [], action: step("stageTools") },
  // Producer work for the TLS consumer, before sealing: the page is bundled once from this source.
  { name: "tls-page-producer.log", eligibility: "production-only", needs: [],
    action: command(context => ({ argv: [bun(context), "scripts/c1/tls-page.ts", join(context.artifact, "publication/tls")] })) },
  { name: "split-producer.log", eligibility: "production-only", needs: [], browser: true,
    action: command(context => ({ argv: [bun(context), "scripts/engine-producer.ts", "build", "split"], overlay: { BUN_WASM_ENGINE_ROOT: engineRoot(context) } })) },
  // Stage-local: the launcher the split producer built and receipted. A global binding
  // would make the producer try to admit a supplied launcher instead.
  { name: "jsc-embedding.log", eligibility: "validated-retained", needs: SPLIT_GUESTS,
    action: command(context => ({ argv: [bun(context), "scripts/jsc-embedding.ts", "test", join(engineRoot(context), "dist/bun-jsc.wasm")],
      overlay: { BUN_WASM_ENGINE_ROOT: engineRoot(context), BUN_WASM_LAUNCHER: join(engineRoot(context), "launcher/bun-wasm") } })) },
  { name: "web-guest-inputs.log", eligibility: "generic-rehearsal", needs: SMOKE_GUESTS, action: step("smokeDefault") },
  { name: "web-guests.log", eligibility: "validated-retained", needs: SMOKE_GUESTS.concat([{ path: "split/dist/bun.wasm", from: "web-guest-inputs.log", validate: guestReceipt }]), browser: true,
    action: command(context => ({ argv: [bun(context), "scripts/test-web-guests.ts", "quickjs", "browser", "jsc"] })) },
  { name: "source-cache-web-inputs.log", eligibility: "generic-rehearsal", needs: SMOKE_GUESTS, action: step("smokeSourceCache") },
  { name: "source-cache-web-guests.log", eligibility: "validated-retained", needs: SMOKE_GUESTS.concat([{ path: "split/dist/bun.wasm", from: "source-cache-web-inputs.log", validate: guestReceipt }]),
    browser: true, action: command(context => ({ argv: [bun(context), "scripts/test-web-guests.ts", "browser"] })) },
  { name: "publication-matrix-inputs.log", eligibility: "generic-rehearsal", needs: SMOKE_GUESTS, action: step("smokeMatrix") },
  { name: "publication-inputs.log", eligibility: "validated-retained", needs: MATRIX_GUESTS, action: step("matrixInputs") },
  { name: "publication-matrix.log", eligibility: "validated-retained", needs: MATRIX_GUESTS.map(need => ({ ...need, from: "publication-inputs.log" })), browser: true,
    action: step("publicationMatrix") },
  { name: "split-verify.log", eligibility: "validated-retained", needs: SPLIT_GUESTS,
    action: command(context => ({ argv: [bun(context), "scripts/engine-producer.ts", "verify", "split"], overlay: { BUN_WASM_ENGINE_ROOT: engineRoot(context) } })) },
  { name: "native-after.log", eligibility: "validated-retained", needs: [], native: true, action: native },
  { name: "capture-after.log", eligibility: "production-only", needs: [], action: step("captureAfter") },
  { name: "native-preseal.log", eligibility: "validated-retained", needs: [], native: true, action: native },
  { name: "capture-preseal.log", eligibility: "production-only", needs: [], action: step("capturePreseal") },
  { name: "publication-stage.log", eligibility: "production-only", needs: [], action: step("stageDelivery") },
  { name: "source-archive.log", eligibility: "production-only", needs: [],
    action: command(context => ({ argv: ["/usr/bin/bash", "-c", "set -euo pipefail\ngit archive HEAD | gzip -n > \"$1\"\n", "source-archive", join(context.artifact, "delivery/source.tar.gz")] })) },
  { name: "complete-publication.log", eligibility: "production-only", needs: [], action: step("verifyDelivery") },
  { name: "seal.log", eligibility: "generic-rehearsal", needs: [], action: step("seal") },
];

class StageDefinitionError extends Error {}
function validAction(action: unknown): boolean {
  if (!action || typeof action !== "object" || !("kind" in action)) return false;
  const keys = Object.keys(action).sort().join(",");
  if (action.kind === "command") return keys === "command,kind" && "command" in action && typeof action.command === "function";
  if (action.kind !== "step" || keys !== "kind,module,name" || !("module" in action) || !("name" in action)) return false;
  return typeof action.module === "string" && isAbsolute(action.module) && typeof action.name === "string" && action.name !== "";
}
/** Unique names, requirements that name earlier stages, and exactly one well-formed action each. */
export function validateStages(stages: readonly Stage[]): void {
  const seen = new Set<string>();
  for (const stage of stages) {
    if (seen.has(stage.name)) throw new StageDefinitionError(`repeated stage ${stage.name}`);
    const missing = stage.needs.find(need => !seen.has(need.from));
    if (missing) throw new StageDefinitionError(`${stage.name} needs ${missing.path} from ${missing.from}, which does not run before it`);
    if (!validAction(stage.action)) throw new StageDefinitionError(`${stage.name} needs exactly one command, or one step module and name`);
    seen.add(stage.name);
  }
}

type Outcome = { readonly status: "ran"; readonly exit: 0 } | { readonly status: "failed"; readonly exit: number; readonly error: string }
  | { readonly status: "blocked" | "skipped"; readonly reason: string };
export type StageIndex = Record<string, Outcome & { readonly command?: readonly string[]; readonly overlay?: Readonly<Record<string, string>> }>;

/** Why a stage may not run in this operation, or undefined when it may. */
export function blockReason(context: StageContext, stage: Stage, outcomes: Readonly<StageIndex>): string | undefined {
  if (stage.native && context.drafts.length) return `native inputs are still draft: ${context.drafts.join("; ")}`;
  if (context.mode === "run") return undefined;
  if (stage.eligibility === "production-only") return "production-only stage never runs in rehearsal";
  const mismatch = stage.eligibility === "validated-retained" && !sameProduced(context);
  if (mismatch) return `retained bytes come from ${context.produced.source?.head ?? "unknown source"} runtime ${context.produced.runtime ?? "unknown"}, not the selected ${context.source.head} runtime ${context.manifest.tuple.runtime}; current-source bytes are missing: ${stage.needs.map(need => need.path).join(", ") || "none named"}`;
  const generic = stage.eligibility === "generic-rehearsal";
  return stage.needs.map(need => requirementReason(context, need, outcomes, generic)).find(reason => reason !== undefined);
}
function sameProduced(context: StageContext): boolean {
  return context.produced.source !== undefined && sameSource(context.produced.source, context.source) && context.produced.runtime === context.manifest.tuple.runtime;
}
/**
 * A blocked, skipped or failed producer blocks every dependent. Generic stages
 * only need the bytes to exist: they copy, never qualify them. Everything a
 * validated stage consumes must validate: either a validated stage made it in
 * this rehearsal, or its own receipt check passes now. A generic stage having
 * run, or a file being present, validates nothing.
 */
function requirementReason(context: StageContext, need: ArtifactRequirement, outcomes: Readonly<StageIndex>, generic: boolean): string | undefined {
  const from = outcomes[need.from];
  if (from && from.status !== "ran") return `prerequisite ${need.from} ${from.status}`;
  const path = join(context.artifact, need.path);
  if (!existsSync(path)) return `required artifact ${need.path} is missing`;
  if (generic) return undefined;
  const producer = STAGES.find(stage => stage.name === need.from);
  if (from && producer?.eligibility === "validated-retained") return undefined;
  if (!need.validate) return `retained ${need.path} has no validator, so it cannot be admitted`;
  try { need.validate(context, path); return undefined; }
  catch (error) { return `retained ${need.path} does not validate: ${error instanceof Error ? error.message : String(error)}`; }
}

function record(context: StageContext, index: StageIndex): void {
  writeFileSync(join(context.report, "stages.json.tmp"), JSON.stringify(index, null, 2) + "\n");
  renameSync(join(context.report, "stages.json.tmp"), join(context.report, "stages.json"));
}
function requireEmptyBrowserTmp(context: StageContext, stage: Stage): void {
  if (stage.browser && readdirSync(context.browserTmp).length) throw new Error(`${stage.name} left browser scratch in ${context.browserTmp}`);
}
/** Hand a step its context through a private file, then run it as an owned child. */
function stepCommand(context: StageContext, stage: Stage, action: { readonly module: string; readonly name: string }): Command {
  const file = join(context.privateRoot, "steps", `${stage.name}.json`);
  mkdirSync(join(context.privateRoot, "steps"), { recursive: true });
  writeFileSync(file, JSON.stringify(serializeContext(context)), { flag: "wx", mode: 0o600 });
  return { argv: [bun(context), STEP_RUNNER, action.module, action.name, file] };
}
async function execute(context: StageContext, stage: Stage, signal: AbortSignal, output: number, drain: DrainTimes): Promise<{ command?: readonly string[]; overlay?: Readonly<Record<string, string>> }> {
  const browser: Record<string, string> = stage.browser ? { TMPDIR: context.browserTmp, TMP: context.browserTmp, TEMP: context.browserTmp } : {};
  const made = stage.action.kind === "step" ? stepCommand(context, stage, stage.action) : stage.action.command(context);
  const overlay = { ...browser, ...made.overlay };
  await runOwned(context.owner, { argv: made.argv, cwd: context.sourceRoot, env: { ...context.env, ...overlay }, output }, signal, drain);
  return { command: made.argv, overlay };
}
/**
 * Run each selected stage in order. A failure stops production; rehearsal
 * records blocked and failed stages and continues with what remains eligible.
 */
export async function runStages(context: StageContext, stages: readonly Stage[], signal: AbortSignal, drain: DrainTimes = STAGE_DRAIN): Promise<StageIndex> {
  validateStages(STAGES);
  validateStages(stages.filter(stage => !STAGES.includes(stage)));
  const index: StageIndex = {};
  for (const stage of stages) {
    signal.throwIfAborted();
    const reason = blockReason(context, stage, index);
    if (reason !== undefined) {
      if (context.mode === "run") throw new Error(`${stage.name} cannot run: ${reason}`);
      index[stage.name] = { status: stage.eligibility === "production-only" ? "skipped" : "blocked", reason };
      record(context, index);
      continue;
    }
    const output = openSync(join(context.report, stage.name), "wx", 0o600);
    try {
      const ran = await execute(context, stage, signal, output, drain);
      requireEmptyBrowserTmp(context, stage);
      index[stage.name] = { status: "ran", exit: 0, ...ran };
    } catch (error) {
      index[stage.name] = { status: "failed", exit: 1, error: error instanceof Error ? error.message : String(error) };
      record(context, index);
      if (context.mode === "run" || signal.aborted) throw error;
      continue;
    } finally { closeSync(output); }
    record(context, index);
  }
  return index;
}
