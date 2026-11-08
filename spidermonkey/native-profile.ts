import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requiredIrregexpUnits } from "./native-source-closure.ts";
import { checkEmojiCustody, unicodeGaps } from "./emoji-sequences.ts";

const recipe = dirname(fileURLToPath(import.meta.url));
const repo = dirname(recipe);
export const pin = "a5df22d986d4b626f771b4f8885241941601c35c";
export const baselineHash = "a8327ca68f7052f239ac887204bac16cead4266b495d66a95a9bf80c4d4c5f26";
export const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const fileHash = (path: string) => hash(readFileSync(path));
const read = (path: string) => readFileSync(path, "utf8");
const run = (program: string, args: string[]) => execFileSync(program, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const identity = (path: string) => ({ path, sha256: fileHash(join(repo, path)) });
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function json(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(read(path));
  assert(record(value), `invalid record: ${path}`);
  return value;
}
function files(path: string): string[] {
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(path.length + 1)).sort();
}
export function overlayFiles(): string[] {
  return files(join(recipe, "irregexp-icu")).filter((path) =>
    path.startsWith("include/") || path.startsWith("generated/") ||
    ["icu_subset.cpp", "allocator.cpp", "property_data.h", "ucd.h"].includes(path));
}
function checkGeneratedCustody(): Record<string, unknown> {
  const custody = json(join(recipe, "irregexp-icu/generated/special-case.inputs.json"));
  assert.equal(custody.mozillaRevision, pin);
  assert.equal(custody.unicodeVersion, "18.0.0");
  assert.equal(custody.ignoreCount, 67);
  assert.deepEqual(custody.supplementary, [0xdf, 0x1e9e]);
  assert.deepEqual(custody.profile, { intlApi: false, irregexpUnicode: "icu4x-subset", specialCase: "selected-data-generated" });
  assert(Array.isArray(custody.generator) && Array.isArray(custody.upstream) && record(custody.output) && record(custody.lock));
  const inputs = custody.generator.concat(custody.upstream, [custody.output, custody.lock]);
  for (const input of inputs) {
    assert(record(input) && typeof input.path === "string" && !input.path.split("/").includes(".."));
    assert.equal(fileHash(join(repo, input.path)), input.sha256, `stale generated custody: ${input.path}`);
  }
  assert.equal(custody.output.sha256, "9970d4a24cd5986e69caa01da064c9a19e30a40a994d0b04e58ac051fbf40daa");
  return custody;
}
export function nativeInputs() {
  const adapter = files(join(recipe, "irregexp-icu")).map((path) => `spidermonkey/irregexp-icu/${path}`);
  const glue = files(join(repo, "crates/bunwasm-spidermonkey/src/glue")).map((path) => `crates/bunwasm-spidermonkey/src/glue/${path}`);
  const recipes = ["common.sh", "fetch-spidermonkey.sh", "build.sh", "check-build.ts", "native-profile.ts", "native-source-closure.ts", "check-message-generation.ts", "mozconfig.in", "spidermonkey-wasi.patch", "generate-special-case.ts", "emoji-sequences.ts", "generate-emoji-sequences.ts"];
  return {
    profile: { intlApi: false, irregexpUnicode: "icu4x-subset", specialCase: "selected-data-generated", finalSigma: "icu4x-case-properties", jit: false, sharedMemory: false, intlProvider: "FormatJS" },
    unicode: { engineTables: "17.0.0", icu4xData: "18.0.0" },
    unsupported: unicodeGaps,
    u2Generation: { status: "generated", ...checkEmojiCustody(repo) },
    recipes: recipes.map((path) => identity(`spidermonkey/${path}`)),
    adapter: adapter.map(identity),
    rust: glue.concat(["Cargo.lock", "crates/bunwasm-spidermonkey/Cargo.toml", "crates/bunwasm-spidermonkey/examples/unicode-special-case.rs"]).map(identity),
    generatedCustody: checkGeneratedCustody(),
  };
}
export function verifyOverlay(root: string): ReturnType<typeof nativeInputs> {
  const overlay = join(root, "firefox/js/src/irregexp/bunwasm-icu");
  assert.deepEqual(files(overlay), overlayFiles(), "unexpected overlay files");
  for (const path of overlayFiles()) assert.equal(fileHash(join(overlay, path)), fileHash(join(recipe, "irregexp-icu", path)), `overlay bytes: ${path}`);
  const inputs = nativeInputs();
  assert.deepEqual(json(join(root, "receipt/native-profile.json")), inputs, "native inputs changed; create a new generation");
  return inputs;
}
export function verifyOverlayFiles(root: string): void {
  const overlay = join(root, "firefox/js/src/irregexp/bunwasm-icu");
  assert.deepEqual(files(overlay), overlayFiles(), "unexpected overlay files");
  for (const path of overlayFiles()) assert.equal(fileHash(join(overlay, path)), fileHash(join(recipe, "irregexp-icu", path)), `overlay bytes: ${path}`);
}

const verifierRecipePaths = new Set(["spidermonkey/check-build.ts", "spidermonkey/native-profile.ts"]);
function withoutVerifierRecipes(value: unknown): unknown[] {
  assert(Array.isArray(value), "native profile recipes must be an array");
  return value.filter((entry: unknown) => !(record(entry) && typeof entry.path === "string" && verifierRecipePaths.has(entry.path)));
}

function verifyProfileSources(profile: Record<string, unknown>, sourceRoot: string): void {
  for (const group of ["recipes", "adapter", "rust"]) {
    const entries = profile[group];
    assert(Array.isArray(entries), `native profile ${group} must be an array`);
    for (const entry of entries) {
      assert(record(entry) && typeof entry.path === "string" && typeof entry.sha256 === "string");
      assert.equal(fileHash(join(sourceRoot, entry.path)), entry.sha256, `original source bytes: ${entry.path}`);
    }
  }
  const custody = profile.generatedCustody;
  assert(record(custody));
  for (const group of ["generator", "upstream"]) {
    const entries: unknown = custody[group];
    assert(Array.isArray(entries), `generated custody ${group} must be an array`);
    for (const entry of entries) {
      assert(record(entry) && typeof entry.path === "string" && typeof entry.sha256 === "string");
      assert.equal(fileHash(join(sourceRoot, entry.path)), entry.sha256, `original generated custody: ${entry.path}`);
    }
  }
  for (const key of ["output", "lock"]) {
    const entry: unknown = custody[key];
    assert(record(entry) && typeof entry.path === "string" && typeof entry.sha256 === "string");
    assert.equal(fileHash(join(sourceRoot, entry.path)), entry.sha256, `original generated custody: ${entry.path}`);
  }
}

export function verifyOriginalProfile(root: string, sourceRoot: string): Record<string, unknown> {
  const actual = json(join(root, "receipt/native-profile.json"));
  assert.equal(fileHash(join(root, "receipt/native-profile.json")), "afbc2dfb71e3c0e73f3c96e26b100d96bbdc0e52de7b83dd9148cf7afd916c1e", "unexpected original native profile");
  const expected = nativeInputs();
  const expectedRecord: Record<string, unknown> = expected;
  for (const key of ["profile", "unicode", "unsupported", "u2Generation", "adapter", "rust", "generatedCustody"]) {
    assert.deepEqual(actual[key], expectedRecord[key], `native profile ${key}`);
  }
  assert.deepEqual(withoutVerifierRecipes(actual.recipes), withoutVerifierRecipes(expected.recipes), "original recipe inputs");
  const verifierRecipes = Array.isArray(actual.recipes) ? actual.recipes.filter((entry: unknown) => record(entry) && typeof entry.path === "string" && verifierRecipePaths.has(entry.path)) : [];
  assert.equal(verifierRecipes.length, verifierRecipePaths.size, "original verifier recipe identities");
  for (const entry of verifierRecipes) {
    assert(record(entry) && typeof entry.path === "string" && typeof entry.sha256 === "string");
    assert.equal(fileHash(join(sourceRoot, entry.path)), entry.sha256, `original verifier recipe identity: ${entry.path}`);
  }
  verifyProfileSources(actual, sourceRoot);
  return actual;
}
export function installOverlay(root: string): void {
  const inputs = nativeInputs();
  const stamp = join(root, "receipt/native-profile.json");
  if (existsSync(stamp)) {
    verifyOverlay(root);
    return;
  }
  assert(!existsSync(join(root, "obj/config.status")), "old native generation; use a fresh lane");
  const overlay = join(root, "firefox/js/src/irregexp/bunwasm-icu");
  assert(!existsSync(overlay), "unowned overlay; use a fresh lane");
  for (const path of overlayFiles()) {
    const destination = join(overlay, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(recipe, "irregexp-icu", path), destination);
  }
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, JSON.stringify(inputs, null, 2) + "\n");
  verifyOverlay(root);
}
export type CompileCommand = { file: string; directory: string; arguments: string[] };
export function commands(raw: unknown): CompileCommand[] {
  assert(Array.isArray(raw));
  return raw.map((entry: unknown) => {
    assert(record(entry) && typeof entry.file === "string" && typeof entry.directory === "string" && Array.isArray(entry.arguments));
    const args = entry.arguments.map((arg: unknown) => { assert(typeof arg === "string"); return arg; });
    return { file: entry.file, directory: entry.directory, arguments: args };
  });
}
function hasDefine(args: readonly string[], name: string): boolean {
  return args.some((arg, index) => arg === `-D${name}` || arg.startsWith(`-D${name}=`) ||
    arg === "-D" && (args[index + 1] === name || args[index + 1]?.startsWith(name + "=")));
}
function flagOperands(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) => arg === flag ? [args[index + 1] ?? ""] : arg.startsWith(flag) ? [arg.slice(flag.length)] : []);
}
export function requireEmbedProfile(args: readonly string[], source: string): void {
  const name = "BUNWASM_EMBED";
  const definitions = flagOperands(args, "-D").filter(value => value.split("=")[0] === name);
  assert(definitions.length > 0 && definitions.every(value => value === name || value === `${name}=1`), `missing or conflicting embed define: ${source}`);
  assert(!flagOperands(args, "-U").some(value => value.split("=")[0] === name), `conflicting embed undefine: ${source}`);
}
export function checkUnicodeCommands(entries: readonly CompileCommand[], root: string) {
  const irregexp = join(root, "firefox/js/src/irregexp") + "/";
  const subset = irregexp + "bunwasm-icu/include";
  const units: string[] = [];
  for (const entry of entries) {
    const path = resolve(entry.directory, entry.file);
    const owned = path.startsWith(irregexp);
    assert(!hasDefine(entry.arguments, "JS_HAS_INTL_API"), `native Intl: ${path}`);
    assert(!entry.arguments.some((arg) => /(?:^|\/)intl\/icu(?:\/|$)/.test(arg)), `ICU4C include: ${path}`);
    const includesSubset = entry.arguments.includes(subset) || entry.arguments.includes("-I" + subset);
    assert(owned || !includesSubset, `subset include outside irregexp: ${path}`);
    if (!owned) continue;
    requireEmbedProfile(entry.arguments, path);
    assert(hasDefine(entry.arguments, "V8_INTL_SUPPORT"), `missing V8_INTL_SUPPORT: ${path}`);
    assert(hasDefine(entry.arguments, "BUNWASM_IRREGEXP_ICU4X") && includesSubset, `missing subset profile: ${path}`);
    units.push(path.slice(irregexp.length));
  }
  for (const name of requiredIrregexpUnits) {
    assert(units.includes(name), `missing compiled irregexp unit: ${name}`);
  }
  assert(!units.includes("imported/special-case.cc"), "original generated support compiled");
  assert(!units.includes("imported/gen-regexp-special-case.cc"), "host generator compiled");
  assert.equal(new Set(units).size, units.length, "duplicate irregexp source recipe");
  assert.deepEqual(units.sort(), requiredIrregexpUnits.toSorted(), "unexpected irregexp source recipe");
  return units;
}
export function symbolSets(text: string) {
  const defined = new Set<string>();
  const undefinedSymbols = new Set<string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^(\S+) ([A-Za-z?])(?:\s|$)/);
    if (!match) continue;
    const [, name, kind] = match;
    assert(name && kind);
    if (["U", "w", "v"].includes(kind)) undefinedSymbols.add(name);
    else defined.add(name);
  }
  return { defined, undefinedSymbols };
}
export const embedHooks = ["bunsm_stack_base", "bunsm_poll_interrupt", "bunsm_pbl_entry", "bunsm_vm_fatal"];
const rustRequirements = ["mozilla_properties_glue_has_property", "mozilla_properties_glue_add_property_ranges", "bunsm_ucd_simple_fold", "bunsm_ucd_is_letter", "bunsm_ucd_close_over_scf", "bunsm_ucd_value_enum", "bunsm_ucd_property_ranges", "bunsm_ucd_is_cased", "bunsm_ucd_is_case_ignorable"];
// Out-of-line definitions in icu_subset.cpp and allocator.cpp; inline helpers need not emit symbols.
const requiredSubsetDefinitions = [
  "_ZN3icu10UnicodeSet10complementEv",
  "_ZN3icu10UnicodeSet21applyIntPropertyValueE13UPropertyEnumiRi",
  "_ZN3icu10UnicodeSet3addEii",
  "_ZN3icu10UnicodeSet6addAllERKS0_",
  "_ZN3icu10UnicodeSet6removeEii",
  "_ZN3icu10UnicodeSet9addStringERKNS_13UnicodeStringE",
  "_ZN3icu10UnicodeSet9closeOverEj",
  "_ZN3icu10UnicodeSet9removeAllERKS0_",
  "_ZN3icu10UnicodeSet9retainAllERKS0_",
  "_ZN3icu6detail10deallocateEPv",
  "_ZN3icu6detail8allocateEm",
  "_ZNK3icu10UnicodeSet11containsAllERKS0_",
  "_ZNK3icu10UnicodeSet12containsNoneERKS0_",
  "_ZNK3icu10UnicodeSet12containsSomeEii",
  "_ZNK3icu10UnicodeSet4sizeEv",
  "_ZNK3icu10UnicodeSet8containsEi",
  "u_foldCase",
  "u_getPropertyEnum",
  "u_getPropertyValueEnum",
  "u_isalpha",
  "bunsm_icu_is_exact_property_alias",
  "bunsm_icu_is_exact_property_value_alias"
];
export function checkSymbolDelta(currentText: string, baselineText: string) {
  const current = symbolSets(currentText);
  const baseline = symbolSets(baselineText);
  const unresolved = Array.from(current.undefinedSymbols).filter((name) => !current.defined.has(name)).sort();
  const baselineUnresolved = new Set(Array.from(baseline.undefinedSymbols).filter((name) => !baseline.defined.has(name)));
  const added = unresolved.filter((name) => !baselineUnresolved.has(name));
  const unresolvedIcu = unresolved.filter((name) => /^u_/.test(name) || /^_ZNK?3icu/.test(name));
  assert.deepEqual(unresolvedIcu, [], "unresolved ICU4C calls");
  assert.deepEqual(added.filter((name) => !rustRequirements.includes(name)), [], "undocumented new native requirement");
  for (const name of rustRequirements) assert(unresolved.includes(name), `missing Rust requirement: ${name}`);
  for (const name of embedHooks) assert(unresolved.includes(name), `missing embed hook requirement: ${name}`);
  const subsetDefinitions = Array.from(current.defined).filter((name) => /^u_/.test(name) || /^_ZNK?3icu/.test(name)).sort();
  for (const name of requiredSubsetDefinitions) assert(current.defined.has(name), `missing subset definition: ${name}`);
  return { unresolved, added, subsetDefinitions };
}
export function nativeSymbols(library: string, baseline: string, sdk: string) {
  assert.equal(fileHash(baseline), baselineHash, "wrong immutable native baseline");
  const tool = join(sdk, "bin/llvm-nm");
  return { baseline: { path: baseline, sha256: baselineHash }, ...checkSymbolDelta(run(tool, ["--format=posix", library]), run(tool, ["--format=posix", baseline])) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  assert(root, "usage: node spidermonkey/native-profile.ts BUILD_DIR");
  installOverlay(resolve(root));
}
