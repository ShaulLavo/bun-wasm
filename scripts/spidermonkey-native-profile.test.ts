import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { discoverChecks } from "./test-checks.ts";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { assertExternalOutput, checkRecordedObjectClosure, qualifierSource, verifyRecordedFiles } from "../spidermonkey/check-build.ts";
import { embedHooks, checkSymbolDelta, checkUnicodeCommands, commands, installOverlay, nativeInputs, overlayFiles, symbolSets, verifyOverlay } from "../spidermonkey/native-profile.ts";

const root = "/work/tmp/bun-wasm-native-profile-fixture";
const irregexp = root + "/firefox/js/src/irregexp/";
import { checkIrregexpClosure, requiredIrregexpUnits } from "../spidermonkey/native-source-closure.ts";
const units = requiredIrregexpUnits;
const entries = units.map((name) => ({ file: irregexp + name, directory: root, arguments: ["clang++", "-DBUNWASM_EMBED=1", "-DV8_INTL_SUPPORT", "-DBUNWASM_IRREGEXP_ICU4X", "-I" + irregexp + "bunwasm-icu/include"] }));
const firstEntry = entries[0];
assert(firstEntry);
const rust = ["mozilla_properties_glue_has_property", "mozilla_properties_glue_add_property_ranges", "bunsm_ucd_simple_fold", "bunsm_ucd_is_letter", "bunsm_ucd_close_over_scf", "bunsm_ucd_value_enum", "bunsm_ucd_property_ranges", "bunsm_ucd_is_cased", "bunsm_ucd_is_case_ignorable"];
const definitions = [
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
const baselineSymbols = ["malloc U"].concat(embedHooks.map(name => `${name} U`)).join("\n");
const symbols = definitions.map((name) => `${name} T 0 1`).concat(rust.concat(embedHooks).map((name) => `${name} U`), ["malloc U", "u_foldCase U"]).join("\n");

test("native Unicode command gate covers every API, shim, generated support and allocator unit", () => {
  assert.equal(checkUnicodeCommands(entries, root).length, units.length);
  for (const unit of units) assert.throws(() => checkUnicodeCommands(entries.filter((entry) => entry.file !== irregexp + unit), root), /missing compiled/);
  const missing = entries.map((entry) => ({ ...entry, arguments: entry.arguments.filter((arg) => arg !== "-DV8_INTL_SUPPORT") }));
  assert.throws(() => checkUnicodeCommands(missing, root), /V8_INTL_SUPPORT/);
  assert.throws(() => checkUnicodeCommands(entries.concat([{ ...firstEntry, file: irregexp + "imported/special-case.cc" }]), root), /original generated/);
});

test("native Unicode command gate rejects native Intl, ICU4C and escaping subset includes", () => {
  for (const extra of [["-DJS_HAS_INTL_API=1"], ["-D", "JS_HAS_INTL_API"], ["-I/firefox/intl/icu/source/common"]]) {
    assert.throws(() => checkUnicodeCommands(entries.map((entry) => ({ ...entry, arguments: entry.arguments.concat(extra) })), root));
  }
  const outside = { file: root + "/firefox/js/src/vm/Interpreter.cpp", directory: root, arguments: firstEntry.arguments };
  assert.throws(() => checkUnicodeCommands(entries.concat([outside]), root), /outside irregexp/);
});

test("archive symbols must resolve ICU in C++ and add only the nine documented Rust entries", () => {
  assert.equal(checkSymbolDelta(symbols, baselineSymbols).added.length, 9);
  assert(symbolSets("archive.a:\nu_foldCase U\nu_foldCase T 0 2").defined.has("u_foldCase"));
  assert.throws(() => checkSymbolDelta(symbols + "\nu_missing U", baselineSymbols), /ICU4C/);
  assert.throws(() => checkSymbolDelta(symbols + "\nnew_core_api U", baselineSymbols), /undocumented/);
  assert.throws(() => checkSymbolDelta(symbols.replace("bunsm_ucd_simple_fold U", ""), baselineSymbols), /missing Rust/);
  assert.throws(() => checkSymbolDelta(symbols.replace("bunsm_ucd_is_cased U", ""), baselineSymbols), /missing Rust/);
});

test("compile database parser rejects untyped or incomplete compiler inputs", () => {
  assert.deepEqual(commands(entries), entries);
  for (const value of [null, [{}], [{ file: "x", directory: "/x", arguments: [1] }]]) assert.throws(() => commands(value));
});

test("fresh-profile overlay installs once, checks exact bytes and rejects stale generations", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-native-profile-test-"));
  try {
    installOverlay(scratch);
    installOverlay(scratch);
    assert.deepEqual(verifyOverlay(scratch), nativeInputs());
    const first = overlayFiles()[0];
    assert(first);
    const path = join(scratch, "firefox/js/src/irregexp/bunwasm-icu", first);
    const original = readFileSync(path);
    writeFileSync(path, "stale");
    assert.throws(() => installOverlay(scratch), /overlay bytes/);
    writeFileSync(path, original);
    writeFileSync(join(scratch, "firefox/js/src/irregexp/bunwasm-icu/extra.h"), "");
    assert.throws(() => verifyOverlay(scratch), /unexpected overlay/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("an old configured tree cannot acquire a new profile", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-native-profile-test-"));
  try {
    mkdirSync(join(scratch, "obj"));
    writeFileSync(join(scratch, "obj/config.status"), "old");
    assert.throws(() => installOverlay(scratch), /old native generation/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});


test("all selected irregexp recipes require the embed define without an undefine", () => {
  const removed = entries.map(entry => ({ ...entry, arguments: entry.arguments.filter(arg => arg !== "-DBUNWASM_EMBED=1") }));
  assert.throws(() => checkUnicodeCommands(removed, root), /embed/);
  for (const flags of [["-UBUNWASM_EMBED"], ["-U", "BUNWASM_EMBED"], ["-DBUNWASM_EMBED=0"]]) {
    assert.throws(() => checkUnicodeCommands(entries.map(entry => ({ ...entry, arguments: entry.arguments.concat(flags) })), root), /embed/);
  }
});

test("the complete pinned closure includes parser and interpreter recipes", () => {
  for (const name of ["imported/regexp-parser.cc", "imported/regexp-interpreter.cc"]) {
    assert.throws(() => checkUnicodeCommands(entries.filter(entry => !entry.file.endsWith(name)), root), /missing compiled/);
  }
});

test("native profile source controls have one blocking discovery owner", () => {
  assert.deepEqual(discoverChecks().filter(check => check.path === "scripts/spidermonkey-native-profile.test.ts").map(check => check.owner), ["quality"]);
  assert(!discoverChecks().some(check => check.path === "spidermonkey/native-profile.test.ts"));
});


test("all G2 embed hook requirements must remain in the new native archive", () => {
  for (const name of embedHooks) assert.throws(() => checkSymbolDelta(symbols.replace(`${name} U`, ""), baselineSymbols), /missing embed hook/);
});


test("normal and unified sources must own actual members of the archive object closure", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-irregexp-closure-"));
  try {
    const sourceRoot = join(root, "firefox/js/src/irregexp");
    const objectRoot = join(root, "obj/js/src/irregexp");
    mkdirSync(objectRoot, { recursive: true });
    for (const source of requiredIrregexpUnits) {
      const path = join(sourceRoot, source);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `synthetic source ownership: ${source}`);
    }
    const normal = "RegExpNativeMacroAssembler.cpp";
    const unifiedName = "Unified_cpp_js_src_irregexp0.cpp";
    const unified = join(objectRoot, unifiedName);
    const included = requiredIrregexpUnits.filter(source => source !== normal);
    const includes = included.map(source => `#include "../../../../firefox/js/src/irregexp/${source}"`).join("\n") + "\n";
    writeFileSync(join(objectRoot, "backend.mk"), `CPPSRCS += $(srcdir)/${normal}\nUNIFIED_CPPSRCS := ${unifiedName}\nCPPSRCS += $(UNIFIED_CPPSRCS)\n`);
    writeFileSync(unified, includes);
    const objects = [join(objectRoot, "RegExpNativeMacroAssembler.o"), join(objectRoot, "Unified_cpp_js_src_irregexp0.o")];
    writeFileSync(objects[0]!, "synthetic normal object bytes");
    writeFileSync(objects[1]!, "synthetic unified object bytes");
    const members = objects.map(path => ({ name: path.slice(path.lastIndexOf("/") + 1), bytes: readFileSync(path) }));
    const proof = { root, sources: requiredIrregexpUnits, objects, members };
    assert.equal(checkIrregexpClosure(proof).sources.length, 26);
    assert.equal(checkIrregexpClosure(proof).objects.length, 2);
    assert.throws(() => checkIrregexpClosure({ ...proof, objects: objects.slice(1) }), /absent from archive closure/);
    assert.throws(() => checkIrregexpClosure({ ...proof, members: members.slice(1) }), /archive member/);
    assert.throws(() => checkIrregexpClosure({ ...proof, members: members.concat([members[0]!]) }), /archive member/);
    writeFileSync(unified, included.slice(1).map(source => `#include "../../../../firefox/js/src/irregexp/${source}"`).join("\n"));
    assert.throws(() => checkIrregexpClosure(proof), /source-to-object/);
    writeFileSync(unified, includes + includes.split("\n")[0] + "\n");
    assert.throws(() => checkIrregexpClosure(proof), /source-to-object/);
    writeFileSync(unified, includes);
    writeFileSync(objects[0]!, "changed compiled object");
    assert.throws(() => checkIrregexpClosure(proof), /archive bytes differ/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every out-of-line subset definition is required, regardless of filler symbol count", () => {
  for (const name of definitions) {
    const without = symbols.replace(`${name} T 0 1`, "").replace(`${name} U`, "");
    const filler = Array.from({ length: 25 }, (_, index) => `_ZN3icu10Unrelated${index} T 0 1`).join("\n");
    assert.throws(() => checkSymbolDelta(without + "\n" + filler, baselineSymbols), /missing subset definition/);
  }
});

function withQualificationFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-native-qualification-test-"));
  try { run(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("artifact-only outputs reject protected roots reached through directory aliases", () => withQualificationFixture(root => {
  const protectedRoot = join(root, "artifact");
  const outside = join(root, "artifact-extra");
  mkdirSync(protectedRoot);
  mkdirSync(outside);
  symlinkSync(protectedRoot, join(outside, "alias"));
  assertExternalOutput(join(outside, "new.json"), [protectedRoot]);
  assert.throws(() => assertExternalOutput(join(outside, "alias/new.json"), [protectedRoot]), /outside protected/);
  assert.throws(() => assertExternalOutput(protectedRoot, [protectedRoot]), /outside protected/);
}));

test("artifact-only output protects each selected source and evidence root", () => withQualificationFixture(root => {
  const roots = ["artifact", "source", "evidence", "baseline", "verifier"].map(name => join(root, name));
  for (const path of roots) mkdirSync(path);
  for (const path of roots) assert.throws(() => assertExternalOutput(join(path, "new.json"), roots), /outside protected/);
  assertExternalOutput(join(root, "new.json"), roots);
}));

test("retained inputs cannot replace their authentic manifest with a self-consistent new one", () => withQualificationFixture(root => {
  const input = join(root, "input");
  const manifest = join(root, "manifest.json");
  const original = JSON.stringify([{ path: input, bytes: 3, sha256: digest("old") }]);
  writeFileSync(input, "old");
  writeFileSync(manifest, original);
  assert.equal(verifyRecordedFiles(manifest, root, digest(original), 1).count, 1);
  assert.throws(() => verifyRecordedFiles(manifest, root, digest(original), 2), /manifest count/);
  writeFileSync(input, "new");
  writeFileSync(manifest, JSON.stringify([{ path: input, bytes: 3, sha256: digest("new") }]));
  assert.throws(() => verifyRecordedFiles(manifest, root, digest(original), 1), /manifest identity/);
}));

test("retained input paths cannot alias bytes outside their declared artifact root", () => withQualificationFixture(root => {
  const artifact = join(root, "artifact");
  mkdirSync(artifact);
  const outside = join(root, "outside");
  writeFileSync(outside, "old");
  const alias = join(artifact, "alias");
  symlinkSync(outside, alias);
  const contents = JSON.stringify([{ path: alias, bytes: 3, sha256: digest("old") }]);
  const manifest = join(root, "manifest.json");
  writeFileSync(manifest, contents);
  assert.throws(() => verifyRecordedFiles(manifest, artifact, digest(contents), 1), /escapes artifact root/);
}));

function qualificationCli(root: string, commit: string, tree: string) {
  const artifact = join(root, "artifact");
  const source = join(root, "source");
  const evidence = join(root, "evidence");
  const baseline = join(root, "baseline");
  for (const path of [artifact, source, evidence, baseline]) mkdirSync(path, { recursive: true });
  return Bun.spawnSync([process.execPath, join(import.meta.dir, "../spidermonkey/check-build.ts"), "--artifact-only", artifact, source, evidence, join(root, "output.json"), commit, tree], {
    env: { ...process.env, SPIDERMONKEY_BASELINE_LIB: join(baseline, "baseline.a") }, stdout: "pipe", stderr: "pipe",
  });
}

for (const receipt of ["vm-library.json", "headers.json"]) test(`artifact-only CLI rejects existing ${receipt} before opening native inputs`, () => withQualificationFixture(root => {
  mkdirSync(join(root, "artifact/receipt"), { recursive: true });
  const path = join(root, "artifact/receipt", receipt);
  writeFileSync(path, "synthetic success marker");
  const result = qualificationCli(root, "0".repeat(40), "1".repeat(40));
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr.toString(), /native success receipt exists/);
  assert.equal(readFileSync(path, "utf8"), "synthetic success marker");
  assert(!existsSync(join(root, "output.json")));
}));

test("artifact-only CLI rejects a different verifier pin before reading retained evidence", () => withQualificationFixture(root => {
  const result = qualificationCli(root, "0".repeat(40), "1".repeat(40));
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr.toString(), /unexpected verifier commit/);
  assert.doesNotMatch(result.stderr.toString(), /ENOENT/);
}));

function fixtureGit(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root].concat(args), { stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout.toString().trim();
}

test("qualifier source binds the requested commit, tree and exact committed files", () => withQualificationFixture(root => {
  fixtureGit(root, ["init", "-q"]);
  mkdirSync(join(root, "spidermonkey"));
  const paths = ["check-build.ts", "native-profile.ts", "native-source-closure.ts"].map(name => join("spidermonkey", name));
  for (const path of paths) writeFileSync(join(root, path), "synthetic verifier\n");
  fixtureGit(root, ["add", "."]);
  fixtureGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const commit = fixtureGit(root, ["rev-parse", "HEAD"]);
  const tree = fixtureGit(root, ["rev-parse", "HEAD^{tree}"]);
  assert.equal(qualifierSource(root, commit, tree).files.length, 3);
  assert.throws(() => qualifierSource(root, "0".repeat(40), tree), /unexpected verifier commit/);
  assert.throws(() => qualifierSource(root, commit, "1".repeat(40)), /unexpected verifier tree/);
  const path = paths[0]!;
  writeFileSync(join(root, path), "changed verifier\n");
  assert.throws(() => qualifierSource(root, commit, tree), /not clean/);
  fixtureGit(root, ["update-index", "--assume-unchanged", path]);
  assert.throws(() => qualifierSource(root, commit, tree), /verifier bytes differ/);
}));

test("every packed member must match the authenticated object manifest and list", () => withQualificationFixture(root => {
  const objects = [join(root, "one.o"), join(root, "two.o")];
  const rows = objects.map(path => ({ path, bytes: 3, sha256: digest("obj") }));
  const manifest = join(root, "manifest.json");
  writeFileSync(manifest, JSON.stringify(rows));
  const members = [{ name: "one.o", bytes: Buffer.from("obj") }, { name: "two.o", bytes: Buffer.from("obj") }];
  checkRecordedObjectClosure(objects, members, manifest);
  assert.throws(() => checkRecordedObjectClosure(objects.slice(0, 1), members, manifest), /object list differs/);
  assert.throws(() => checkRecordedObjectClosure(objects.concat(objects[0]!), members, manifest), /duplicate/);
  assert.throws(() => checkRecordedObjectClosure(objects, members.slice(0, 1), manifest), /archive members differ/);
  assert.throws(() => checkRecordedObjectClosure(objects, [{ name: "one.o", bytes: Buffer.from("bad") }, members[1]!], manifest), /archive members differ/);
}));
