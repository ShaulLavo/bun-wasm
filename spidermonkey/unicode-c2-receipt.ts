import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { importDelta } from "../scripts/side-import-delta.ts";
import { checkObject } from "./check-build.ts";
import { checkEmojiCustody, unicodeGaps } from "./emoji-sequences.ts";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function identity(path: string) {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.length, sha256: hash(bytes) };
}
function inventory(directory: string): ReturnType<typeof identity>[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" }).sort()
    .filter((path) => statSync(join(directory, path)).isFile())
    .map((path) => identity(join(directory, path)));
}
function lockEntries(path: string) {
  const wanted = new Set(["icu_properties", "icu_properties_data", "icu_casemap", "icu_casemap_data", "icu_collections", "icu_normalizer"]);
  return readFileSync(path, "utf8").split("[[package]]").flatMap((block) => {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    if (!name || !wanted.has(name)) return [];
    return [{ name, version: block.match(/^version = "([^"]+)"$/m)?.[1], checksum: block.match(/^checksum = "([^"]+)"$/m)?.[1] }];
  });
}
function imports(module: WebAssembly.Module): string[] {
  return WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}:${item.kind}`).sort();
}
function compilerInputs(output: string) {
  const cpp = readdirSync(output).filter((name) => name.endsWith(".d")).map((name) => join(output, name));
  const target = join(output, "target");
  const rust = readdirSync(target, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".d")).map((name) => join(target, name));
  const dependencies = cpp.concat(rust).flatMap((path) => {
    const text = readFileSync(path, "utf8").replaceAll("\\\n", " ");
    return text.slice(text.indexOf(":") + 1).trim().split(/\s+/);
  });
  return Array.from(new Set(dependencies)).sort().filter((path) =>
    path.startsWith("/") && !path.endsWith(":") && existsSync(path) && statSync(path).isFile()).map(identity);
}

function main() {
  const [output, native, early] = process.argv.slice(2);
  assert(output && native && early, "usage: unicode-c2-receipt.ts OUTPUT NATIVE EARLY_REPORT");
  const originalPath = join(resolve(native, ".."), "spidermonkey-engine.wasm");
  const original = identity(originalPath);
  assert.equal(original.bytes, 13252977);
  assert.equal(original.sha256, "909a53851a84f67e5ec51214d2566e7783ae2302f8c669d9c6d6c4a2a8f9db56");
  const baseline = identity(join(output, "base.wasm"));
  const probe = identity(join(output, "probe.wasm"));
  const baseModule = new WebAssembly.Module(readFileSync(baseline.path));
  const probeModule = new WebAssembly.Module(readFileSync(probe.path));
  checkObject(readFileSync(baseline.path));
  checkObject(readFileSync(probe.path));
  const exported = new Set(WebAssembly.Module.exports(probeModule).map((item) => item.name));
  const imported = new Set(WebAssembly.Module.imports(probeModule).map((item) => item.name));
  const required = Array.from(new Set(readFileSync(join(output, "required-exports.txt"), "utf8").trim().split("\n")));
  for (const name of required) {
    assert(exported.has(name), `missing retained definition: ${name}`);
    assert(!imported.has(name), `probe imported rather than defined: ${name}`);
  }
  const map = readFileSync(join(output, "probe.map"), "utf8");
  const rustStd = Array.from(new Set(Array.from(map.matchAll(/std-([0-9a-f]{16})/g), (match) => match[1])));
  assert.equal(rustStd.length, 1, "exactly one Rust std archive identity");
  assert(!map.includes("libjsrust"));
  for (const name of ["allocator.o", "icu_subset.o", "probe.o", "ZoneShimFFI.o", "special-case.o"]) {
    assert(map.includes(name), `complete C++ object not retained: ${name}`);
  }
  const baseImports = new Set(imports(baseModule));
  const addedImports = imports(probeModule).filter((name) => !baseImports.has(name));
  const core = new WebAssembly.Module(readFileSync(join(resolve(native, ".."), "bun-spidermonkey.wasm")));
  const coreExports = new Set(WebAssembly.Module.exports(core).map((item) => item.name));
  const addedCoreImports = importDelta(probeModule, coreExports);
  const selfBoundImports = WebAssembly.Module.imports(probeModule).filter((item) =>
    item.module === "env" && exported.has(item.name)).map((item) => item.name).sort();
  const sourceLock = lockEntries("Cargo.lock");
  assert.deepEqual(lockEntries(join(output, "Cargo.lock")), sourceLock, "probe locks all ICU crates identically to the source");
  const receipt = {
    gate: "C2", scope: "independent forced-retention size probe, not N1/N2/G3 acceptance",
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    sourceDiffSha256: hash(execFileSync("git", ["diff", "--binary", "HEAD"], { maxBuffer: 16 * 1024 * 1024 })),
    compilerInputFiles: compilerInputs(output),
    earlySource: [identity(join(early, "engine-execution.cpp")), identity(join(early, "vm-execution.rs"))],
    native: [identity(join(native, "libspidermonkey_g2.a")), identity(join(native, "native-inputs.json")), identity(join(native, "js-confdefs.h"))],
    rustCrateInputs: [identity("crates/bunwasm-spidermonkey/Cargo.toml"), identity("crates/bunwasm-spidermonkey/build.rs"), identity("crates/bunwasm-spidermonkey/src/lib.rs")],
    sourceLock: identity("Cargo.lock"), probeLock: identity(join(output, "Cargo.lock")), lockEntries: sourceLock,
    adapterInputs: inventory("spidermonkey/irregexp-icu"),
    generatedSpecialCase: identity("spidermonkey/irregexp-icu/generated/special-case.cc"),
    generatedSpecialCaseCustody: identity("spidermonkey/irregexp-icu/generated/special-case.inputs.json"),
    selectedSupport: "ICU4X 2.4 PrintSpecial output, not the pinned empty supplementary table",
    rustInputs: inventory("crates/bunwasm-spidermonkey/src/glue"),
    controlInputs: [identity("spidermonkey/relink-unicode-c2.sh"), identity("spidermonkey/unicode-c2-receipt.ts")],
    probeInputs: [identity(join(output, "Cargo.toml")), identity(join(output, "early-side.rs")), identity(join(output, "libearly-side-unicode.a"))],
    original, baseline, probe,
    reconstructionDeltaBytes: baseline.bytes - original.bytes,
    measuredDeltaBytes: probe.bytes - baseline.bytes,
    deltaAgainstRetainedEarlyBytes: probe.bytes - original.bytes,
    limitBytes: 350000,
    sizePass: probe.bytes - baseline.bytes <= 350000 && probe.bytes - original.bytes <= 350000,
    finalSideLineBytes: 14000000, finalSideGate: "N2 not run",
    retainedExportDefinitions: required, rustStd, exceptionTagSections: 0, exceptionTagImports: 0, libjsrustIncluded: false, addedImports, addedCoreImports, selfBoundImports,
    unicode: { engineTables: "17.0.0", icu4xData: "18.0.0" },
    unsupported: unicodeGaps,
    u2Generation: { status: "generated", ...checkEmojiCustody() },
    orderedGateAccepted: false,
  };
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ baseline: baseline.bytes, probe: probe.bytes, delta: receipt.measuredDeltaBytes,
    originalDelta: receipt.deltaAgainstRetainedEarlyBytes, sizePass: receipt.sizePass, addedImports, addedCoreImports, rustStd,
    retainedExportCount: required.length }, null, 2) + "\n");
  assert.deepEqual(addedCoreImports, [], "pure Unicode glue must introduce no new core imports");
}
main();
