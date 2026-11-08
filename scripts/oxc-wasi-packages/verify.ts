import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import inputs from "./inputs.lock.json" with { type: "json" };
import { digest, verifyFiles } from "./acquire.ts";
import { addons, object, strings, variantVersion } from "./config.ts";
import { checkClosure } from "./run.ts";

export function descriptor(source: string) {
  const matches = Array.from(source.matchAll(/new WebAssembly\.Memory\(\{\s*initial: (\d+(?:e\d+)?),\s*maximum: (\d+(?:e\d+)?),\s*shared: (true|false),?\s*\}\)/g));
  if (matches.length !== 1) throw new Error(`Expected one literal shared-memory descriptor, got ${matches.length}`);
  const match = matches[0];
  if (!match) throw new Error("Missing descriptor");
  return { initial: Number(match[1]), maximum: Number(match[2]), shared: match[3] === "true", start: match.index, length: match[0].length };
}

export function assertPolicy(source: string) {
  const { initial, maximum, shared } = descriptor(source);
  assert.deepEqual({ initial, maximum, shared }, { initial: 1024, maximum: 4096, shared: true });
}

function withoutDescriptor(source: string) {
  const { start, length } = descriptor(source);
  return source.slice(0, start) + source.slice(start + length);
}

async function verifySourceOutputs(work: string) {
  const comparisons = [];
  for (const addon of addons) {
    const original = join(work, addon.addon, "package");
    const maintained = join(work, "maintained", addon.addon, "npm/wasm32-wasi");
    await checkClosure(maintained);
    await verifyFiles(maintained, { [`${addon.addon}.wasm32-wasi.wasm`]: addon.wasmSha256 });
    for (const suffix of ["wasi.cjs", "wasi-browser.js"]) {
      const file = `${addon.addon}.${suffix}`;
      const before = await readFile(join(original, file), "utf8");
      const after = await readFile(join(maintained, file), "utf8");
      assert.throws(() => assertPolicy(before), { name: "AssertionError" });
      assertPolicy(after);
      assert.equal(withoutDescriptor(before), withoutDescriptor(after), "No loader selection or NAPI semantics may change");
      comparisons.push({ file, original: descriptor(before), maintained: descriptor(after) });
    }
    for (const worker of ["wasi-worker.mjs", "wasi-worker-browser.mjs"]) {
      assert.equal(digest(await readFile(join(maintained, worker))), digest(await readFile(join(original, worker))));
    }
  }
  return comparisons;
}

async function verifyParserBundle(work: string, dependencies: string) {
  const esbuild: unknown = await import(pathToFileURL(join(dependencies, "node_modules/esbuild/lib/main.js")).href);
  const transform = object(esbuild).transform;
  if (typeof transform !== "function") throw new Error("Missing esbuild transform");
  const original = await readFile(join(work, "parser/package/browser-bundle.js"), "utf8");
  const baseline = await readFile(join(work, "baseline/parser/npm/wasm32-wasi/browser-bundle.js"), "utf8");
  const maintained = await readFile(join(work, "maintained/parser/npm/wasm32-wasi/browser-bundle.js"), "utf8");
  const before = object(await transform(original, { minify: true }));
  const after = object(await transform(baseline, { minify: true }));
  assert.equal(before.code, after.code, "Baseline bundle may differ only in build-path comments");
  assert.throws(() => assertPolicy(original), { name: "AssertionError" });
  assertPolicy(maintained);
  assert.equal(withoutDescriptor(baseline), withoutDescriptor(maintained));
  return { baselineEquivalentAfterMinification: true, maintainedDescriptor: descriptor(maintained), noBundleRuntimeUpgrade: true };
}

async function unpack(work: string, dependencies: string, scratch: string) {
  const results = [];
  for (const addon of addons) {
    const archive = join(work, "packed", `oxc-${addon.addon}-binding-wasm32-wasi-${variantVersion}.tgz`);
    const installation = join(scratch, addon.addon);
    await mkdir(installation);
    execFileSync("tar", ["-xzf", archive, "-C", installation, "--no-same-owner", "--no-same-permissions"]);
    await symlink(join(dependencies, "node_modules"), join(installation, "node_modules"), "dir");
    const originalInstallation = join(installation, "original");
    await mkdir(originalInstallation);
    execFileSync("tar", ["-xzf", join(work, `${addon.addon}.tgz`), "-C", originalInstallation, "--no-same-owner", "--no-same-permissions"]);
    const originalDirectory = join(originalInstallation, "package");
    const directory = join(installation, "package");
    const manifest = object(JSON.parse(await readFile(join(directory, "package.json"), "utf8")));
    assert.equal(manifest.name, addon.name);
    assert.equal(manifest.version, variantVersion);
    await checkClosure(directory);
    assert.equal(digest(await readFile(join(directory, `${addon.addon}.wasm32-wasi.wasm`))), addon.wasmSha256);
    const expected = strings(manifest.files).concat(["package.json", "README.md"]).sort();
    assert.deepEqual((await readdir(directory)).sort(), expected);
    results.push({ addon: addon.addon, files: expected, sha256: digest(await readFile(archive)), directory, originalDirectory });
  }
  return results;
}

function nodeControl(directory: string, dependencies: string, addon: string, mode: "original" | "maintained") {
  const control = fileURLToPath(new URL("./addon-control.ts", import.meta.url));
  const output = execFileSync("node", [control, directory, dependencies, addon, mode], { encoding: "utf8", timeout: 45_000, killSignal: "SIGKILL" });
  return object(JSON.parse(output));
}

export async function verify(work: string, dependencies: string, scratch: string) {
  const descriptors = await verifySourceOutputs(work);
  const bundle = await verifyParserBundle(work, dependencies);
  await mkdir(scratch);
  try {
    const packed = await unpack(work, dependencies, scratch);
    const controls = [];
    for (const packageInput of packed) {
      const original = nodeControl(packageInput.originalDirectory, dependencies, packageInput.addon, "original");
      const maintained = nodeControl(packageInput.directory, dependencies, packageInput.addon, "maintained");
      assert.deepEqual(original.exports, maintained.exports);
      controls.push(original, maintained);
    }
    return { source: inputs.source.commit, descriptors, bundle, packed, controls };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [work, dependencies, scratch] = process.argv.slice(2);
  if (!work || !dependencies || !scratch) throw new Error("Usage: bun verify.ts <generated-work-directory> <isolated-dependencies-directory> <new-control-scratch>");
  process.stdout.write(JSON.stringify(await verify(resolve(work), resolve(dependencies), resolve(scratch)), null, 2) + "\n");
}
