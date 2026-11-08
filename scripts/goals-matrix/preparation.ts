import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "./catalog";
import { engineFiles, registeredEngineGroups } from "./engines";
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
async function stagedEngine(root: string, names: readonly string[]): Promise<{ name: string; data: Uint8Array }[]> {
  const staged: { name: string; data: Uint8Array }[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const data = await bytes(root, name);
    if (data) staged.push({ name, data });
    else missing.push(name);
  }
  if (staged.length && missing.length) throw new Error(`Preparation error: Missing engine assets: ${missing.join(", ")}`);
  return staged;
}
export async function preflight(root: string, engines: readonly Engine[]): Promise<void> {
  const staged: { name: string; data: Uint8Array }[] = [];
  for (const engine of engines) staged.push(...await stagedEngine(root, engineFiles(engine)));
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
async function writeStagedEngine(source: string, directory: string, names: readonly string[]): Promise<void> {
  for (const { name, data } of await stagedEngine(source, names)) await writeFile(join(directory, name), data);
}
export async function withStagedAssets<T>(source: string, build: (directory: string) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-assets-"));
  try {
    await mkdir(scratch, { recursive: true });
    for (const names of registeredEngineGroups().concat([["bun-tools.wasm"]])) await writeStagedEngine(source, scratch, names);
    return await build(scratch);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
