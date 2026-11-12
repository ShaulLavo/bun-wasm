import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "./catalog";
import { engineFiles, profileEngineFiles, registeredEngineGroups } from "./engines";
import { parseMemoryProfile, profileAsset, type ProgramMemoryProfile } from "../../web/src/program-profile";
import { programProfile, type PairedEngine } from "../../src/engine-kind";
import { sharedProgramReceipts } from "../stage-program-profiles";
export interface SpiderMonkeyInput { directory: string; source: string }
export function preparationOptions(args: readonly string[]): { delivery: string; spidermonkey?: SpiderMonkeyInput; shell?: string; profile?: ProgramMemoryProfile } {
  const [delivery, ...flags] = args;
  if (!delivery || delivery.startsWith("--")) throw new Error("Usage: bun scripts/goals-matrix/prepare.ts /absolute/delivery [--spidermonkey=/absolute/pair --spidermonkey-source=/absolute/source.json] [--shell=/absolute/guests] [--profile=split|shared-group]");
  const options = new Map<string, string>();
  for (const flag of flags) {
    const match = /^--(spidermonkey|spidermonkey-source|shell|profile)=(.+)$/.exec(flag);
    if (!match?.[1] || !match[2] || options.has(match[1])) throw new Error(`Unknown or repeated preparation option: ${flag}`);
    options.set(match[1], match[2]);
  }
  const directory = options.get("spidermonkey"), source = options.get("spidermonkey-source");
  if (Boolean(directory) !== Boolean(source)) throw new Error("Set --spidermonkey and --spidermonkey-source together");
  const shell = options.get("shell");
  return { delivery: resolve(delivery), spidermonkey: directory && source ? { directory: resolve(directory), source: resolve(source) } : undefined, shell: shell ? resolve(shell) : undefined, ...(options.has("profile") ? { profile: parseMemoryProfile(options.get("profile")) } : {}) };
}
function hashes(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Preparation error: expected an engine fingerprint map");
  const entries = Object.entries(value);
  if (entries.some(([, hash]) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw new Error("Preparation error: invalid engine fingerprint");
  return Object.fromEntries(entries);
}
async function bytes(root: string, name: string): Promise<Uint8Array | undefined> {
  const compressed = Bun.file(join(root, name + ".gz"));
  if (await compressed.exists()) return Bun.gunzipSync(await compressed.bytes());
  const plain = Bun.file(join(root, name));
  return await plain.exists() ? plain.bytes() : undefined;
}
async function stagedEngine(root: string, names: readonly string[], required = false): Promise<{ name: string; data: Uint8Array }[]> {
  const staged: { name: string; data: Uint8Array }[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const data = await bytes(root, name);
    if (data) staged.push({ name, data });
    else missing.push(name);
  }
  if (missing.length && (required || staged.length)) throw new Error(`Preparation error: Missing engine assets: ${missing.join(", ")}`);
  return staged;
}
export async function preflight(root: string, engines: readonly Engine[], profile: ProgramMemoryProfile = "split"): Promise<void> {
  const staged: { name: string; data: Uint8Array }[] = [];
  for (const engine of engines) {
    const files = await stagedEngine(root, profileEngineFiles(engine, profile));
    if (profile === "shared-group" && !files.length) throw new Error(`Preparation error: Missing ${engine} ${profile} assets`);
    staged.push(...files);
  }
  if (!staged.length) return;
  const index = await readFile(join(root, "index.html"), "utf8");
  const embedded = /globalThis\.__bunwasmBuilds\s*=\s*(\{[^;]*?\})\s*;/.exec(index)?.[1];
  if (!embedded) throw new Error("Preparation error: built host has no embedded __bunwasmBuilds map");
  const host = hashes(JSON.parse(embedded));
  const manifest = hashes(JSON.parse(await readFile(join(root, "engine-builds.json"), "utf8")));
  for (const { name, data } of staged) {
    const actual = new Bun.CryptoHasher("sha256").update(data).digest("hex");
    if (host[name] !== actual || manifest[name] !== actual) throw new Error(`Preparation error: ${name} embedded host, manifest, and staged bytes disagree; stage assets before building the playground`);
  }
}
async function writeStagedEngine(source: string, directory: string, names: readonly string[], required = false): Promise<void> {
  for (const { name, data } of await stagedEngine(source, names, required)) await Bun.write(join(directory, name), data);
}
export async function withStagedAssets<T>(source: string, build: (directory: string) => Promise<T>, options: { spidermonkey?: string } = {}): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-assets-"));
  try {
    await mkdir(scratch, { recursive: true });
    const spiderMonkeyCore = engineFiles("spidermonkey")[0];
    for (const names of registeredEngineGroups().concat([["bun-tools.wasm"]])) {
      const selected = spiderMonkeyCore !== undefined && names.includes(spiderMonkeyCore) ? options.spidermonkey : undefined;
      await writeStagedEngine(selected ?? source, scratch, names, selected !== undefined);
    }
    for (const engine of ["quickjs", "jsc", "spidermonkey"] as const) await stageSharedEngine(source, scratch, engine);
    return await build(scratch);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function stageSharedEngine(source: string, scratch: string, engine: PairedEngine): Promise<void> {
  const files = await stagedEngine(source, profileEngineFiles(engine, "shared-group"));
  if (!files.length) return;
  const directory = join(scratch, `shared-${engine}`);
  const names = programProfile(engine);
  await mkdir(directory);
  for (const file of files) {
    const name = file.name === profileAsset(names.core, "shared-group") ? "bun.wasm" : names.side;
    await writeFile(join(directory, name), file.data);
  }
  for (const name of sharedProgramReceipts(engine)) {
    await cp(join(source, profileAsset(`receipts/${engine}/${name}`, "shared-group")), join(directory, name));
  }
}
