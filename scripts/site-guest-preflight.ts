import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { verifyGuestBuildReceipt, verifyGuestCompanions } from "./guest-build-receipt";
import { guestBuilds, hash, type SourceManifest } from "./guest-source-manifest";

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

export async function verifySiteGuests(repository: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const expected = await runtimeInputs(repository);
  for (const guest of guests) {
    const name = guestBuilds[guest.build].artifact;
    const path = resolve(repository, "sandbox", env[guest.variable] ?? `../dist/${name}`);
    const receipt: unknown = JSON.parse(await readFile(`${path}.build.json`, "utf8"));
    verifyGuestBuildReceipt(await readFile(path), receipt);
    if (receipt.sourceManifest.build !== guest.build) throw new Error(`Site guest engine mismatch: ${path}`);
    verifyRuntimeInputs(receipt.sourceManifest, expected, path);
    await verifyGuestCompanions(receipt, dirname(path));
  }
}

if (import.meta.main) await verifySiteGuests(resolve(import.meta.dir, ".."));
