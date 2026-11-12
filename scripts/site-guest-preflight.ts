import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { verifyGuestBuildReceipt, verifyGuestCompanions } from "./guest-build-receipt";
import { guestBuilds, hash, type SourceManifest } from "./guest-source-manifest";
import { programKind } from "../src/engine-kind";
import { parseInputs, verifyPairReceipt } from "./spidermonkey-side-core-receipt";
import { sideSourceSha256 } from "./spidermonkey-side-inputs";

const guests = [
  { build: "browser", variable: "BUN_BROWSER_WASM" },
  { build: "quickjs", variable: "BUN_WASM" },
  { build: "jsc", variable: "JSC_WASM" },
  { build: "tools", variable: "BUN_TOOLS_WASM" },
] as const;

const runtimeDirectory = "crates/bunwasm-runtime/src/js";
const generators = ["crates/bunwasm-runtime/build/polyfills.rs", "scripts/transpile-runtime.ts",
  "scripts/generate-bun-wrap.ts", "scripts/generate-direct-stream.ts", "web/src/native-direct-stream.ts"];
function embeddedInput(path: string): boolean {
  if (generators.includes(path)) return true;
  return path.startsWith(`${runtimeDirectory}/`) && /\.(js|ts)$/.test(path) && !path.endsWith(".d.ts");
}
async function runtimeInputs(repository: string) {
  const names = await readdir(join(repository, runtimeDirectory));
  const paths = generators.concat(names.map(name => `${runtimeDirectory}/${name}`).filter(embeddedInput));
  return Promise.all(paths.sort().map(async path => {
    const bytes = await readFile(join(repository, path));
    return { path, sha256: hash(bytes), bytes: bytes.byteLength };
  }));
}
function verifyRuntimeInputs(manifest: SourceManifest, expected: Awaited<ReturnType<typeof runtimeInputs>>, artifact: string): void {
  const recorded = new Map(manifest.groups.find(group => group.name === "repository")!.files.filter(file => embeddedInput(file.path)).map(file => [file.path, file]));
  const differences: string[] = [];
  for (const file of expected) {
    const previous = recorded.get(file.path);
    if (previous?.sha256 !== file.sha256 || previous.bytes !== file.bytes) differences.push(file.path);
    recorded.delete(file.path);
  }
  differences.push(...recorded.keys());
  if (differences.length) throw new Error(`Site guest has stale embedded runtime inputs: ${artifact}\n${differences.sort().join("\n")}\nRebuild the guest from this checkout before publishing the site.`);
}

export function resolveSiteSpiderMonkey(repository: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.SPIDERMONKEY_WASM;
  if (override === "") throw new Error("SPIDERMONKEY_WASM must select a core file");
  const path = resolve(repository, "web", override ?? "../dist/bun-spidermonkey.wasm");
  return override !== undefined || existsSync(path) ? path : null;
}

export async function verifySiteGuests(repository: string, env: NodeJS.ProcessEnv = process.env,
  spiderMonkey: string | null = resolveSiteSpiderMonkey(repository, env)): Promise<void> {
  const expected = await runtimeInputs(repository);
  for (const guest of guests) {
    const name = guestBuilds[guest.build].artifact;
    const paths = new Set(["sandbox", "web"].map(app => resolve(repository, app, env[guest.variable] ?? `../dist/${name}`)));
    for (const path of paths) await verifySiteGuest(path, guest.build, expected);
  }
  if (spiderMonkey) await verifySiteSpiderMonkey(repository, spiderMonkey, resolve(repository, "web", env.BUN_WASM ?? "../dist/bun.wasm"));
}

function readUnsigned(bytes: Uint8Array, cursor: { at: number }): number {
  let value = 0;
  for (let shift = 0; shift <= 28; shift += 7) {
    const byte = bytes[cursor.at++];
    if (byte === undefined) throw new Error("Truncated Wasm section length");
    value += (byte & 127) * 2 ** shift;
    if (byte < 128) return value;
  }
  throw new Error("Invalid Wasm section length");
}

function untaggedCore(bytes: Uint8Array, engine: "quickjs" | "spidermonkey"): Buffer {
  assert.equal(programKind(new WebAssembly.Module(Uint8Array.from(bytes))), engine, "Site core has the wrong engine tag");
  const kept = [bytes.subarray(0, 8)];
  const cursor = { at: 8 };
  while (cursor.at < bytes.length) {
    const start = cursor.at;
    const id = bytes[cursor.at++];
    const length = readUnsigned(bytes, cursor);
    const end = cursor.at + length;
    assert(end <= bytes.length, "Truncated Wasm section");
    const nameLength = id === 0 ? readUnsigned(bytes, cursor) : 0;
    const name = new TextDecoder().decode(bytes.subarray(cursor.at, cursor.at + nameLength));
    if (id !== 0 || name !== "bun-wasm-engine") kept.push(bytes.subarray(start, end));
    cursor.at = end;
  }
  return Buffer.concat(kept);
}

async function verifySiteSpiderMonkey(repository: string, core: string, quickjs: string): Promise<void> {
  const inputs = parseInputs(JSON.parse(await readFile(join(dirname(core), "inputs.json"), "utf8")));
  assert.equal(inputs.sideSourceSha256, sideSourceSha256(repository), "Site SpiderMonkey has stale side source inputs");
  verifyPairReceipt(core, join(dirname(core), "spidermonkey-engine.wasm"), `${core}.spidermonkey.json`, inputs);
  assert(untaggedCore(await readFile(core), "spidermonkey").equals(untaggedCore(await readFile(quickjs), "quickjs")),
    "Site SpiderMonkey common core differs from the qualified QuickJS core");
}

async function verifySiteGuest(path: string, build: typeof guests[number]["build"], expected: Awaited<ReturnType<typeof runtimeInputs>>): Promise<void> {
  const receipt: unknown = JSON.parse(await readFile(`${path}.build.json`, "utf8"));
  verifyGuestBuildReceipt(await readFile(path), receipt);
  if (receipt.sourceManifest.build !== build) throw new Error(`Site guest engine mismatch: ${path}`);
  verifyRuntimeInputs(receipt.sourceManifest, expected, path);
  await verifyGuestCompanions(receipt, dirname(path));
}

if (import.meta.main) await verifySiteGuests(resolve(import.meta.dir, ".."));
