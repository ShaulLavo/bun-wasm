import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { hash } from "./guest-source-manifest.ts";
import { programProfile, type PairedEngine } from "../src/engine-kind.ts";
import type { ProgramProfile } from "./src/program-profile.ts";

export interface ProducerSource { readonly head: string; readonly tree: string }
interface LauncherReceipt {
  readonly source: ProducerSource;
  readonly artifact: { readonly sha256: string; readonly bytes: number };
}
const producerFeatures = ["engine-split", "bun-transpiler", "bun-build"];
const splitEngines: readonly PairedEngine[] = ["quickjs", "jsc", "hermes"];
const groupEngines: readonly PairedEngine[] = ["quickjs"];
export function producerEngines(profile: ProgramProfile): readonly PairedEngine[] {
  return profile === "split" ? splitEngines : groupEngines;
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
  }), profile === "split" ? ["dist/bun-jsc.wasm.embedding.json", "inputs/hermes-vm.json", "dist/bash-web-shell.wasm", "dist/bash-web-env.wasm", "dist/bash-web-guests.json", "web/index.html", "web/engine-builds.json", "hook-controls.log", "hook-smoke.json"] : ["core/cxx-runtime-members.json", "worker-proof.log"]);
}
export function requireClosureFiles(profile: ProgramProfile, files: readonly { readonly path: string }[]): void {
  const paths = new Set(files.map(file => file.path));
  if (paths.size !== files.length) throw new Error("Repeated producer manifest path");
  for (const path of producerArtifactPaths(profile)) if (!paths.has(path)) throw new Error(`Missing producer manifest artifact: ${path}`);
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

/** A native archive is never refreshed here; its owner must supply a matching generation. */
export function verifyHermesLibrary(repository: string, build: string, receiptPath: string): void {
  const value: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (!value || typeof value !== "object" || !("sha256" in value) || !("bytes" in value) || !("shimSha256" in value)) throw new Error("Hermes VM receipt must identify archive bytes and shim source");
  const bytes = readFileSync(join(build, "wasi/lib/libhermesvm_bunwasm.a"));
  const shim = readFileSync(join(repository, "crates/bunwasm-hermes/cpp/shim.cpp"));
  if (value.sha256 !== hash(bytes) || value.bytes !== bytes.byteLength || value.shimSha256 !== hash(shim)) throw new Error("Hermes archive or shim changed; a new matching native generation is required");
}
