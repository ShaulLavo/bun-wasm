import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyGuestBuildReceipt } from "../guest-build-receipt.ts";
import { publicationGuestPaths } from "../producer-closure.ts";
import { sameSource, type SourceIdentity } from "./contract.ts";
import { sealDelivery, sealTree, treeMembers, type SealFacts } from "./delivery.ts";
import { runOwned } from "./process.ts";
import {
  capture, initialize, matrixInputs, publicationMatrix, smokeInputs, stageDelivery, stageGuest, verifyDelivery, type PublicationContext,
} from "./publication.ts";

/**
 * Who may run a stage. Production-only stages build or create production
 * records and never run in rehearsal. Validated-retained stages consume
 * produced bytes and run in rehearsal only on retained bytes of the selected
 * source whose requirements validate. Generic stages exercise copying,
 * restaging and sealing mechanics and may run on any private copy.
 */
type Eligibility = "production-only" | "validated-retained" | "generic-rehearsal";
interface Command { readonly argv: readonly string[]; readonly overlay?: Readonly<Record<string, string>> }
type Action =
  | { readonly kind: "command"; readonly command: (context: StageContext) => Command }
  | { readonly kind: "step"; readonly step: (context: StageContext, signal: AbortSignal) => Promise<void> | void };
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
  /** Source and runtime the artifact bytes were produced from (the selected ones in production). */
  readonly produced: { readonly source: SourceIdentity | undefined; readonly runtime: string | undefined };
  readonly drafts: readonly string[];
}

const bun = (context: StageContext) => context.env.BUN_EXE ?? "bun";
const engineRoot = (context: StageContext) => join(context.artifact, "split");
const NATIVE_CHECK = "set -euo pipefail\nsource jsc/common.sh\ncheck_jsc_inputs_stamp\n\"$BUN_EXE\" scripts/build-wasi-sysroot.ts\n";
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
/**
 * Native checks keep Git writes out of the original WebKit repository: new
 * objects go to a private directory with the originals as alternates, and no
 * object is fetched.
 */
function nativeCheck(context: StageContext, name: string): Command {
  const webkit = join(context.manifest.native.jsc.root, "webkit/.git/objects");
  const objects = join(context.privateRoot, "git-objects", name);
  mkdirSync(objects, { recursive: true });
  return { argv: ["/usr/bin/bash", "-c", NATIVE_CHECK], overlay: { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: webkit, GIT_NO_LAZY_FETCH: "1" } };
}
const command = (make: (context: StageContext) => Command): Action => ({ kind: "command", command: make });
const step = (run: (context: StageContext, signal: AbortSignal) => Promise<void> | void): Action => ({ kind: "step", step: run });

/** A retained guest must carry a valid receipt from the selected source. */
function guestReceipt(context: StageContext, path: string): void {
  const receipt: unknown = JSON.parse(readFileSync(`${path}.build.json`, "utf8"));
  verifyGuestBuildReceipt(readFileSync(path), receipt);
  if (!sameSource(receipt.sourceManifest.source, context.source)) throw new Error(`retained guest ${path} was built from another source`);
}
const split = (path: string): ArtifactRequirement => ({ path: `split/${path}`, from: "split-producer.log" });
const guest = (path: string, from: string): ArtifactRequirement => ({ path: `publication/${path}`, from, validate: guestReceipt });
const SPLIT_GUESTS = [split("manifest.json"), split("launcher/bun-wasm"), { path: "split/dist/bun.wasm", from: "split-producer.log", validate: guestReceipt },
  { path: "split/dist/bun-jsc.wasm", from: "split-producer.log", validate: guestReceipt }];
const PUBLICATION_GUESTS = [guest(publicationGuestPaths.browser, "browser-stage.log"), guest(publicationGuestPaths["source-cache-browser"], "source-cache-browser-producer.log"),
  guest(publicationGuestPaths.tools, "tools-stage.log")];

/** The one production sequence. Rehearsal selects a suffix of these same definitions. */
export const STAGES: readonly Stage[] = [
  { name: "native-before.log", eligibility: "validated-retained", needs: [], native: true, action: command(context => nativeCheck(context, "before")) },
  { name: "publication-initialize.log", eligibility: "production-only", needs: [], action: step(initialize) },
  { name: "capture-before.log", eligibility: "production-only", needs: [], action: step(context => capture(context, "before")) },
  { name: "browser-producer.log", eligibility: "production-only", needs: [], action: command(() => ({ argv: ["/usr/bin/bash", "scripts/build-bun-browser.sh"] })) },
  { name: "browser-stage.log", eligibility: "production-only", needs: [], action: step(context => stageGuest(context, "browser")) },
  { name: "source-cache-browser-producer.log", eligibility: "production-only", needs: [], action: command(context => ({ argv: ["/usr/bin/bash", "-c", SOURCE_CACHE, "source-cache-browser",
    join(context.privateRoot, "targets/source-cache-browser"), join(context.privateRoot, "source-cache-browser-inputs.json"), join(context.artifact, "publication", publicationGuestPaths["source-cache-browser"])] })) },
  { name: "tools-producer.log", eligibility: "production-only", needs: [], action: command(() => ({ argv: ["/usr/bin/bash", "scripts/build-bun-tools.sh"] })) },
  { name: "tools-stage.log", eligibility: "production-only", needs: [], action: step(context => stageGuest(context, "tools")) },
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
  { name: "web-guest-inputs.log", eligibility: "generic-rehearsal", needs: SPLIT_GUESTS.concat(PUBLICATION_GUESTS), action: step(context => smokeInputs(context, "default")) },
  { name: "web-guests.log", eligibility: "validated-retained", needs: [{ path: "split/dist/bun.wasm", from: "web-guest-inputs.log" }], browser: true,
    action: command(context => ({ argv: [bun(context), "scripts/test-web-guests.ts", "quickjs", "browser", "jsc"] })) },
  { name: "source-cache-web-inputs.log", eligibility: "generic-rehearsal", needs: SPLIT_GUESTS.concat(PUBLICATION_GUESTS), action: step(context => smokeInputs(context, "source-cache")) },
  { name: "source-cache-web-guests.log", eligibility: "validated-retained", needs: [{ path: "split/dist/bun.wasm", from: "source-cache-web-inputs.log" }], browser: true,
    action: command(context => ({ argv: [bun(context), "scripts/test-web-guests.ts", "browser"] })) },
  { name: "publication-matrix-inputs.log", eligibility: "generic-rehearsal", needs: SPLIT_GUESTS.concat(PUBLICATION_GUESTS), action: step(context => smokeInputs(context, "matrix")) },
  { name: "publication-inputs.log", eligibility: "validated-retained", needs: [{ path: "publication-matrix/bun-browser.wasm", from: "publication-matrix-inputs.log" }], action: step(matrixInputs) },
  { name: "publication-matrix.log", eligibility: "validated-retained", needs: [{ path: "publication-matrix/bun-browser.wasm", from: "publication-inputs.log" }], browser: true,
    action: step((context, signal) => publicationMatrix(context, signal)) },
  { name: "split-verify.log", eligibility: "validated-retained", needs: SPLIT_GUESTS,
    action: command(context => ({ argv: [bun(context), "scripts/engine-producer.ts", "verify", "split"], overlay: { BUN_WASM_ENGINE_ROOT: engineRoot(context) } })) },
  { name: "native-after.log", eligibility: "validated-retained", needs: [], native: true, action: command(context => nativeCheck(context, "after")) },
  { name: "capture-after.log", eligibility: "production-only", needs: [], action: step(context => capture(context, "after")) },
  { name: "native-preseal.log", eligibility: "validated-retained", needs: [], native: true, action: command(context => nativeCheck(context, "preseal")) },
  { name: "capture-preseal.log", eligibility: "production-only", needs: [], action: step(context => capture(context, "preseal")) },
  { name: "publication-stage.log", eligibility: "production-only", needs: [], action: step(context => { stageDelivery(context); }) },
  { name: "source-archive.log", eligibility: "production-only", needs: [],
    action: command(context => ({ argv: ["/usr/bin/bash", "-c", "set -euo pipefail\ngit archive HEAD | gzip -n > \"$1\"\n", "source-archive", join(context.artifact, "delivery/source.tar.gz")] })) },
  { name: "complete-publication.log", eligibility: "production-only", needs: [], action: step(context => verifyDelivery(context, join(context.artifact, "delivery"))) },
  { name: "seal.log", eligibility: "generic-rehearsal", needs: [], action: step(seal) },
];

/**
 * Production seals DELIVERY.json once. Rehearsal applies the same seal
 * mechanics to its private copy under a rehearsal-only inventory and never
 * writes producer status; copied historical status files are just members.
 */
function seal(context: StageContext): void {
  const delivery = join(context.artifact, "delivery");
  if (context.mode === "run") { sealDelivery(delivery, context.facts); return; }
  if (!existsSync(delivery)) throw new Error("rehearsal copy has no delivery to seal");
  const members = treeMembers(delivery, []);
  sealTree(delivery, "REHEARSAL-INVENTORY.json", { schema: "bun-wasm.c1-rehearsal-inventory/1", qualifying: false, producerStatus: null, files: members }, members);
}

class StageDefinitionError extends Error {}
/** Unique names, requirements that name earlier stages, and exactly one action each. */
export function validateStages(stages: readonly Stage[]): void {
  const seen = new Set<string>();
  for (const stage of stages) {
    if (seen.has(stage.name)) throw new StageDefinitionError(`repeated stage ${stage.name}`);
    const missing = stage.needs.find(need => !seen.has(need.from));
    if (missing) throw new StageDefinitionError(`${stage.name} needs ${missing.path} from ${missing.from}, which does not run before it`);
    const action: unknown = stage.action;
    const kind = action && typeof action === "object" && "kind" in action ? action.kind : undefined;
    const valid = kind === "command" ? "command" in (action as object) && !("step" in (action as object)) : kind === "step" && "step" in (action as object) && !("command" in (action as object));
    if (!valid) throw new StageDefinitionError(`${stage.name} needs exactly one command or step action`);
    seen.add(stage.name);
  }
}

type Outcome ={ readonly status: "ran"; readonly exit: 0 } | { readonly status: "failed"; readonly exit: number; readonly error: string }
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
 * A requirement holds when its producing stage ran here, or (for retained
 * bytes) when the bytes exist and validate against the selected source. A
 * blocked, skipped or failed producer blocks every dependent. Generic stages
 * only need the bytes to exist: they copy, never qualify them.
 */
function requirementReason(context: StageContext, need: ArtifactRequirement, outcomes: Readonly<StageIndex>, generic: boolean): string | undefined {
  const from = outcomes[need.from];
  if (from && from.status !== "ran") return `prerequisite ${need.from} ${from.status}`;
  const path = join(context.artifact, need.path);
  if (!existsSync(path)) return `required artifact ${need.path} is missing`;
  if (from || generic) return undefined;
  if (!sameProduced(context)) return `retained ${need.path} is not from the selected source`;
  if (!need.validate) return undefined;
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
async function execute(context: StageContext, stage: Stage, signal: AbortSignal, output: number): Promise<{ command?: readonly string[]; overlay?: Readonly<Record<string, string>> }> {
  const browser: Record<string, string> = stage.browser ? { TMPDIR: context.browserTmp, TMP: context.browserTmp, TEMP: context.browserTmp } : {};
  if (stage.action.kind === "step") { await stage.action.step(context, signal); return {}; }
  const made = stage.action.command(context);
  const overlay = { ...browser, ...made.overlay };
  await runOwned(context.owner, { argv: made.argv, cwd: context.sourceRoot, env: { ...context.env, ...overlay }, output }, signal);
  return { command: made.argv, overlay };
}
/**
 * Run each selected stage in order. A failure stops production; rehearsal
 * records blocked and failed stages and continues with what remains eligible.
 */
export async function runStages(context: StageContext, stages: readonly Stage[], signal: AbortSignal): Promise<StageIndex> {
  validateStages(STAGES);
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
      const ran = await execute(context, stage, signal, output);
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
