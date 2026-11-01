import { accessSync, constants, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pairedEngines, programProfile, type Engine, type PairedEngine } from "../src/engine-kind.ts";
import type { ProgramProfile } from "./src/program-profile.ts";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export interface ProducerSource { readonly head: string; readonly tree: string }
interface LauncherReceipt {
  readonly source: ProducerSource;
  readonly artifact: { readonly sha256: string; readonly bytes: number };
}
const producerFeatures = ["engine-split", "bun-transpiler", "bun-build"];
const groupEngines: readonly PairedEngine[] = ["quickjs"];
export function producerEngines(profile: ProgramProfile): readonly PairedEngine[] {
  return profile === "split" ? pairedEngines : groupEngines;
}
export function producerScopes(profile: ProgramProfile): readonly ("core" | PairedEngine)[] {
  const scopes: ("core" | PairedEngine)[] = ["core"];
  return scopes.concat(producerEngines(profile));
}
export function producerSelection(profile: ProgramProfile) {
  return profile === "split" ? { features: producerFeatures } : { features: producerFeatures, profile };
}
export function producerArtifactPaths(profile: ProgramProfile): string[] {
  const engines = producerEngines(profile);
  const paths = ["inputs/programs.json", "core/bun-core.wasm", "core/bun-core.wasm.core.json", "launcher/bun-wasm", "launcher/bun-wasm.launcher.json"];
  return paths.concat(engines.flatMap(engine => {
    const names = programProfile(engine);
    return [`${engine}/engine.wasm`, `${engine}/engine.wasm.engine.json`, `dist/${names.core}`, `dist/${names.core}.build.json`, `dist/${names.side}`, `dist/${names.side}.engine.json`, `${engine}-smoke.log`].concat(profile === "split" ? [`${engine}-node-smoke.log`] : []);
  }), profile === "split" ? ["dist/bun-jsc.wasm.embedding.json", "dist/bash-web-shell.wasm", "dist/bash-web-env.wasm", "dist/bash-web-guests.json", "web/index.html", "web/engine-builds.json", "hook-controls.log", "hook-smoke.json"] : ["core/cxx-runtime-members.json", "worker-proof.log"], profile === "split" ? publicationAssets.map(name => `web/${name}.gz`) : []);
}
export function requireClosureFiles(profile: ProgramProfile, files: readonly { readonly path: string }[]): void {
  for (const file of files) rejectWithdrawnPublicationPath(file.path);
  const paths = new Set(files.map(file => file.path));
  if (paths.size !== files.length) throw new Error("Repeated producer manifest path");
  const required = new Set(producerArtifactPaths(profile));
  for (const path of required) if (!paths.has(path)) throw new Error(`Missing producer manifest artifact: ${path}`);
  for (const path of paths) {
    if (required.has(path) || (profile === "split" && path.startsWith("web/") && !/\.wasm(?:\.|$)/.test(path))) continue;
    throw new Error(`Unexpected producer manifest artifact: ${path}`);
  }
}
/** Output names only. Dormant repository source remains valid provenance, never a shipped guest. */
export function rejectWithdrawnPublicationPath(path: string): void {
  if (/(?:^|[/.\\_-])hermes(?:$|[/.\\_-])/i.test(path)) throw new Error(`Withdrawn engine publication artifact: ${path}`);
}
/** The outer publication owns these guests separately from the paired-core producer. */
export const publicationGuestPaths = {
  browser: "browser/default/bun-browser.wasm",
  "source-cache-browser": "browser/source-cache/bun-browser.wasm",
  tools: "tools/bun-tools.wasm",
} as const;
const publicationPaired: readonly Engine[] = pairedEngines;
export const publicationEngines: readonly Engine[] = publicationPaired.concat(["browser"]);
export const publicationAssets: readonly string[] = pairedEngines.flatMap<string>(engine => {
  const profile = programProfile(engine);
  return [profile.core, profile.side];
}).concat(["bun-browser.wasm", "bun-tools.wasm"]);

/** Reject partial or extended asset registries, including stale withdrawn-engine references. */
export function verifyPublicationBuilds(value: unknown): asserts value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid publication asset registry");
  const names = Object.keys(value);
  if (names.length !== publicationAssets.length || names.some(name => !publicationAssets.includes(name))) throw new Error("Publication asset registry must contain only the complete supported engine assets");
  for (const name of publicationAssets) {
    const fingerprint: unknown = Reflect.get(value, name);
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error(`Invalid publication asset fingerprint: ${name}`);
  }
}

/** Required outer delivery files. Existing byte, actor, matrix and custody validators still apply. */
export function completePublicationArtifactPaths(): string[] {
  const guests = Object.values(publicationGuestPaths).flatMap(path => [path, `${path}.build.json`]);
  const custody = ["before", "after", "preseal"].flatMap(phase => [
    `inputs/${phase}.json`, `inputs/vendor-custody-${phase}.json`, `inputs/native-custody-${phase}.json`,
  ]);
  return producerArtifactPaths("split").map(path => `split/${path}`).concat(guests, custody,
    [
      "source.tar.gz", "inputs/ADMISSION.json", "inputs/CANONICAL-REUSE.json", "inputs/publication-matrix.json",
      "split/hook-cleanup.json", "inputs/NATIVE-CANDIDATE-ADMISSION.json", "inputs/browser-consumer.json",
      "inputs/runtime107-release.tgz", "inputs/programs-release/program-release.json", "inputs/programs-release/SHA256SUMS",
      "inputs/vendor-bun.bundle", "inputs/vendor-bundle-proof.json", "bash/ORIGIN.json", "bash/original-native.zip",
      "bash/original-sidecars/SHA256SUMS", "bash/original-sidecars/cli-source.txt", "bash/original-sidecars/cli-sha256.txt",
      "bash/original-sidecars/inputs", "bash/original-sidecars/THIRD_PARTY_NOTICES.txt",
      "native/jsc/.bunwasm-artifacts", "native/jsc/.bunwasm-inputs", "native/jsc/native-header-manifest.json",
      "native/jsc/build/jsc/CMakeCache.txt", "native/jsc/build/jsc/cmakeconfig.h", "native/jsc/build/jsc/compile_commands.json",
      "native/jsc/inputs/wasi-jsc.cmake", "native/jsc/inputs/shim/wasi-compat.h", "native/jsc/inputs/shim/wasi-compat.c", "native/jsc/inputs/shim/madvise.c",
    ]);
}

export function requireCompletePublicationFiles(files: readonly { readonly path: string }[]): void {
  for (const file of files) rejectWithdrawnPublicationPath(file.path);
  const paths = new Set(files.map(file => file.path));
  if (paths.size !== files.length) throw new Error("Repeated publication manifest path");
  for (const path of completePublicationArtifactPaths()) if (!paths.has(path)) throw new Error(`Missing complete publication artifact: ${path}`);
}

/** JSC and the shared sysroot retain their existing original-input admission checks. */
export function verifyPublicationNativeBacking(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "jsc,sysroot") throw new Error("Publication native backing must contain only JSC and the sysroot");
  for (const name of ["jsc", "sysroot"]) {
    const path: unknown = Reflect.get(value, name);
    if (typeof path !== "string" || !path.startsWith("/")) throw new Error(`Invalid publication native backing: ${name}`);
  }
}

export const workerProofLabels = ["worker-to-main wake", "worker plain store visible in main", "main-to-worker wake", "worker read main's store and answered", "buffer posted on the port aliases", "timed-out", "not-equal", "alias worker exit", "blocked worker started", "terminate cancels a blocked futex wait", "20 sequential members settled", "main still owns the buffer"];
export function verifyWorkerProof(output: string, status: number | null): void {
  const lines = output.split("\n").filter(line => line.startsWith("PASS "));
  if (status !== 0 || /^FAIL /m.test(output) || lines.length !== workerProofLabels.length
    || workerProofLabels.some((label, index) => lines[index] !== `PASS ${label}` && !lines[index]?.startsWith(`PASS ${label} `))) throw new Error("Shared-group worker proof failed");
}
export function launcherReceipt(path: string, source: ProducerSource): LauncherReceipt {
  accessSync(path, constants.X_OK);
  const bytes = readFileSync(path);
  return { source, artifact: { sha256: hash(bytes), bytes: bytes.byteLength } };
}
export function verifyLauncher(path: string, value: unknown, source: ProducerSource): LauncherReceipt {
  if (!value || typeof value !== "object" || !("source" in value) || !("artifact" in value)) throw new Error("Invalid launcher receipt");
  const expected = launcherReceipt(path, source);
  const origin = value.source;
  const artifact = value.artifact;
  if (!origin || typeof origin !== "object" || !("head" in origin) || !("tree" in origin)
    || origin.head !== source.head || origin.tree !== source.tree) throw new Error("Launcher source differs from its original receipt");
  if (!artifact || typeof artifact !== "object" || !("sha256" in artifact) || !("bytes" in artifact)
    || artifact.sha256 !== expected.artifact.sha256 || artifact.bytes !== expected.artifact.bytes) throw new Error("Launcher artifact differs from its original receipt");
  return expected;
}
