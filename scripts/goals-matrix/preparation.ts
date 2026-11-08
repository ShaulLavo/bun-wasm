import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "./catalog";
const programs: Record<string, readonly string[]> = {
  browser: ["bun-browser.wasm"], quickjs: ["bun.wasm", "quickjs.wasm"], jsc: ["bun-jsc.wasm", "jsc-engine.wasm"],
};
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
export async function preflight(root: string, engines: readonly Engine[]): Promise<void> {
  const required = Array.from(new Set(engines.flatMap(engine => programs[engine] ?? [])));
  const staged: { name: string; data: Uint8Array }[] = [];
  for (const name of required) {
    const data = await bytes(root, name);
    if (data) staged.push({ name, data });
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
export async function withStagedAssets<T>(source: string, build: (directory: string) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-assets-"));
  try {
    await mkdir(scratch, { recursive: true });
    for (const name of Object.values(programs).flat().concat(["bun-tools.wasm"])) {
      const data = await bytes(source, name);
      if (data) await writeFile(join(scratch, name), data);
    }
    return await build(scratch);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
