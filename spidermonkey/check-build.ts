import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkIrregexpClosure, type ArchiveMember } from "./native-source-closure.ts";
import { checkUnicodeCommands, commands, nativeSymbols, record, requireEmbedProfile, verifyOriginalProfile, verifyOverlay, verifyOverlayFiles } from "./native-profile.ts";

const pin = "a5df22d986d4b626f771b4f8885241941601c35c";
const recipe = dirname(fileURLToPath(import.meta.url));
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path: string) => hash(readFileSync(path));
const output = (program: string, args: string[]) => execFileSync(program, args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });

type Cursor = { offset: number };
function leb(bytes: Buffer, cursor: Cursor): number {
  let result = 0;
  let shift = 0;
  while (true) {
    assert(cursor.offset < bytes.length && shift < 35, "invalid Wasm LEB");
    const byte = bytes[cursor.offset++];
    assert(byte !== undefined);
    result += (byte & 127) * 2 ** shift;
    if ((byte & 128) === 0) return result;
    shift += 7;
  }
}

function skipName(bytes: Buffer, cursor: Cursor): void {
  const length = leb(bytes, cursor);
  cursor.offset += length;
  assert(cursor.offset <= bytes.length, "truncated name");
}

function skipLimits(bytes: Buffer, cursor: Cursor): void {
  const flags = leb(bytes, cursor);
  assert((flags & 4) === 0, "expected wasm32 limits");
  leb(bytes, cursor);
  if (flags & 1) leb(bytes, cursor);
}

function checkImports(bytes: Buffer, start: number): void {
  const cursor = { offset: start };
  const count = leb(bytes, cursor);
  for (let index = 0; index < count; index++) {
    skipName(bytes, cursor);
    skipName(bytes, cursor);
    const kind = bytes[cursor.offset++];
    assert(kind !== 4, "exception tag import");
    if (kind === 0) leb(bytes, cursor);
    else if (kind === 1) { cursor.offset++; skipLimits(bytes, cursor); }
    else if (kind === 2) skipLimits(bytes, cursor);
    else if (kind === 3) cursor.offset += 2;
    else assert.fail(`unknown import kind ${kind}`);
  }
}

export function checkObject(bytes: Buffer): void {
  assert(bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), "non-Wasm archive member");
  const cursor = { offset: 8 };
  while (cursor.offset < bytes.length) {
    const id = bytes[cursor.offset++];
    const length = leb(bytes, cursor);
    const end = cursor.offset + length;
    assert(end <= bytes.length, "truncated Wasm section");
    assert(id !== 13, "exception tag section");
    if (id === 2) checkImports(bytes.subarray(0, end), cursor.offset);
    cursor.offset = end;
  }
}

export function archiveMembers(bytes: Buffer): ArchiveMember[] {
  assert.equal(bytes.subarray(0, 8).toString(), "!<arch>\n", "expected regular archive");
  let offset = 8;
  let names: Buffer = Buffer.alloc(0);
  const members: ArchiveMember[] = [];
  while (offset < bytes.length) {
    let name = bytes.subarray(offset, offset + 16).toString().trim();
    const size = Number(bytes.subarray(offset + 48, offset + 58).toString().trim());
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 60 + size <= bytes.length, "invalid archive member");
    let member = bytes.subarray(offset + 60, offset + 60 + size);
    offset += 60 + size + (size % 2);
    if (name === "//") { names = member; continue; }
    if (["/", "/SYM64/"].includes(name)) continue;
    if (/^\/\d+$/.test(name)) {
      const index = Number(name.slice(1));
      const end = names.indexOf(10, index);
      assert(index < names.length && end >= index, "invalid archive filename index");
      name = names.subarray(index, end).toString().replace(/\/$/, "");
    } else if (name.startsWith("#1/")) {
      const length = Number(name.slice(3));
      assert(Number.isSafeInteger(length) && length > 0 && length <= member.length, "invalid archive extended filename");
      name = member.subarray(0, length).toString().replace(/\0+$/, "");
      member = member.subarray(length);
    } else name = name.replace(/\/$/, "");
    assert(name.endsWith(".o"), "unexpected native archive member");
    members.push({ name, bytes: member });
  }
  return members;
}
export function checkArchive(bytes: Buffer): { wasmObjects: number; objectsReferencingMemoryBase: number } {
  const members = archiveMembers(bytes);
  let objectsReferencingMemoryBase = 0;
  for (const member of members) {
    checkObject(member.bytes);
    if (member.bytes.includes(Buffer.from("__memory_base"))) objectsReferencingMemoryBase++;
  }
  assert(members.length > 0 && objectsReferencingMemoryBase > 0, "expected PIC Wasm objects");
  return { wasmObjects: members.length, objectsReferencingMemoryBase };
}

export function checkCommands(raw: unknown, sdk: string, sysroot: string): number {
  assert(Array.isArray(raw), "compile commands must be an array");
  let targetCommands = 0;
  for (const entry of raw) {
    assert(entry && typeof entry === "object" && "arguments" in entry && "file" in entry);
    assert(typeof entry.file === "string" && Array.isArray(entry.arguments));
    const args = entry.arguments;
    assert(args.every((arg: unknown) => typeof arg === "string"));
    if (!args[0]?.startsWith(join(sdk, "bin") + "/")) continue;
    requireEmbedProfile(args, entry.file);
    assert(args.includes("-fPIC"), `missing PIC: ${entry.file}`);
    assert(args.includes("-fno-exceptions"), `missing no-exceptions: ${entry.file}`);
    assert(args.includes(sysroot), `wrong sysroot: ${entry.file}`);
    const triples = args.flatMap((arg: string, index: number) => {
      if (arg === "--target" || arg === "-target") return [args[index + 1]];
      return arg.startsWith("--target=") || arg.startsWith("-target=") ? [arg.slice(arg.indexOf("=") + 1)] : [];
    });
    assert(triples.every((triple: unknown) => triple === "wasm32-wasip1" || triple === "wasm32-unknown-wasip1"), "expected wasm32-wasip1 target");
    assert(!args.some((arg: string) => ["-fno-pic", "-fno-PIC", "-fexceptions"].includes(arg)), "conflicting compiler flags");
    targetCommands++;
  }
  assert(targetCommands > 0, "no target compile commands");
  return targetCommands;
}

export function checkRelocations(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of text.matchAll(/\b(R_WASM_\w+)\s+(\S+)/g)) {
    const [, kind, symbol] = match;
    assert(kind && symbol);
    counts[kind] = (counts[kind] ?? 0) + 1;
    assert(!/^R_WASM_MEMORY_ADDR_(?:LEB|SLEB)$/.test(kind), `non-PIC code relocation: ${match[0]}`);
    const libcState = /^(?:stdout|stderr|stdin|__stdout|__stderr|__stdin|environ|__environ|errno|__stack_chk_guard)$/;
    assert(!(kind === "R_WASM_MEMORY_ADDR_I32" && libcState.test(symbol)), `absolute libc-state relocation: ${match[0]}`);
  }
  assert(Object.keys(counts).length > 0, "no relocations");
  return counts;
}

function objectList(path: string): string[] {
  const entries = readFileSync(path, "utf8").trim().split(/\r?\n/);
  assert(entries.length > 0 && entries.every((entry) => entry.endsWith(".o") && existsSync(entry)), `invalid object list: ${path}`);
  return entries;
}

export function supportObjectNames(backend: string): string[] {
  const unified = backend.match(/^UNIFIED_CPPSRCS := (.+)$/m)?.[1]?.split(/\s+/) ?? [];
  const sources = Array.from(backend.matchAll(/^CPPSRCS \+= (.+)$/gm), (match) => {
    const source = match[1];
    assert(source);
    return source;
  });
  const explicit = sources.filter((source) => source !== "$(UNIFIED_CPPSRCS)");
  assert(explicit.every((source) => source?.startsWith("$(srcdir)/") && source.endsWith(".cpp")), "unknown support source rule");
  return unified.concat(explicit).map((source) => {
    assert(source);
    return source.slice(source.lastIndexOf("/") + 1).replace(/\.cpp$/, ".o");
  });
}

function pack(root: string, sdk: string): { library: string; inputs: string[]; objects: string[] } {
  const obj = join(root, "obj");
  const jsList = join(obj, "js/src/build/libjs_static_a.list");
  const support = ["memory/build", "memory/mozalloc", "mfbt", "mozglue/misc", "mozglue/baseprofiler", "third_party/fmt"];
  const inputs = [jsList].concat(support.map((dir) => join(obj, dir, "backend.mk")));
  const supportObjects = support.flatMap((dir) => supportObjectNames(readFileSync(join(obj, dir, "backend.mk"), "utf8")).map((name) => join(obj, dir, name)));
  const objects = Array.from(new Set(objectList(jsList).concat(supportObjects)));
  assert(supportObjects.length > 0 && objects.every((path) => path.startsWith(obj + "/") && existsSync(path)), "invalid archive object closure");
  const list = join(root, "receipt/archive-objects.txt");
  writeFileSync(list, objects.join("\n") + "\n");
  const library = join(root, "libspidermonkey_bunwasm.a");
  writeFileSync(library + ".new", "!<arch>\n");
  output(join(sdk, "bin/llvm-ar"), ["rcs", library + ".new", "@" + list]);
  renameSync(library + ".new", library);
  return { library, inputs, objects };
}

export function headerManifest(root: string): { count: number; sha256: string; bytes: string } {
  const include = join(root, "obj/dist/include");
  const headers = readdirSync(include, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(?:h|hpp|inc)$/.test(path) && statSync(join(include, path)).isFile());
  headers.sort();
  assert(headers.length > 0, "no exported headers");
  const manifest = headers.map((path) => ({ path, sha256: fileHash(join(include, path)) }));
  const bytes = JSON.stringify(manifest, null, 2) + "\n";
  return { count: headers.length, sha256: hash(bytes), bytes };
}

export function headerIdentity(root: string, mode: "write" | "verify" = "write"): { count: number; sha256: string } {
  const manifest = headerManifest(root);
  const saved = join(root, "receipt/headers.json");
  if (mode === "verify") assert.equal(readFileSync(saved, "utf8"), manifest.bytes, "saved header manifest changed");
  else writeFileSync(saved, manifest.bytes);
  return { count: manifest.count, sha256: manifest.sha256 };
}

const originalBuildHead = "1a53e2123e4876be671a9a03eb025ae569795001";
const originalBuildTree = "c494195936b4b23bfc8bef9fdcb624e513fa82e4";
const correctedVerifierHead = "844e52995826ec31d297aaecdd74d53641f9f7fb";
const correctedVerifierTree = "07a3a274840464d084c199a035168426ba4c368e";
const originalArchiveSha256 = "cd74d436981ea486e30b580235361e03d6f04693b376dc847f49981453963787";
const originalArchiveBytes = 25287880;
const originalProfileSha256 = "afbc2dfb71e3c0e73f3c96e26b100d96bbdc0e52de7b83dd9148cf7afd916c1e";
const diagnosticHeadersSha256 = "4230df97600e54d46e76bba402153edc7f6ecf0f9d81d33c148f9ea51a0ed23f";
const diagnosticHeadersCount = 407;
const originalFailureReportSha256 = "e017b837198d1a83a7d8ebc45c9cb01957c230df8b0f0ebe225f66685ca57579";
const originalFailureExitSha256 = "4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865";
const retainedInputsSha256 = "9968da656890ce8521ddc01af16cc7d6b971eb5550df429a8fca608fa0e24305";
const retainedObjectsSha256 = "6c3fe460d1c87c311b227e68d3f1657bd2009a889eb04189d218a8ddf349f5ec";

function verifyRecordedFile(entry: unknown, root: string): void {
  assert(record(entry) && typeof entry.path === "string" && typeof entry.bytes === "number" && typeof entry.sha256 === "string");
  const path = realpathSync(entry.path);
  assert(path.startsWith(root + "/"), `recorded input escapes artifact root: ${entry.path}`);
  assert.equal(statSync(path).size, entry.bytes, `recorded input size: ${entry.path}`);
  assert.equal(fileHash(path), entry.sha256, `recorded input bytes: ${entry.path}`);
}

export function verifyRecordedFiles(path: string, root: string, expectedSha256: string, expectedCount: number): { count: number; sha256: string } {
  const bytes = readFileSync(path);
  const sha256 = hash(bytes);
  assert.equal(sha256, expectedSha256, `retained manifest identity: ${path}`);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  assert(Array.isArray(value) && value.length > 0, `invalid retained input manifest: ${path}`);
  assert.equal(value.length, expectedCount, `retained manifest count: ${path}`);
  const canonicalRoot = realpathSync(root);
  for (const entry of value) verifyRecordedFile(entry, canonicalRoot);
  return { count: value.length, sha256 };
}

function verifyOriginalSource(root: string): { count: number; sha256: string; diffSha256: string } {
  const firefox = join(root, "firefox");
  const paths = output("git", ["-C", firefox, "ls-files", "-z"]).split("\0").filter((path) => path && existsSync(join(firefox, path)));
  const manifest = paths.map((path) => ({ path, sha256: fileHash(join(firefox, path)) }));
  const bytes = JSON.stringify(manifest, null, 2) + "\n";
  assert.equal(readFileSync(join(root, "receipt/mozilla-source.json"), "utf8"), bytes, "retained Mozilla source changed");
  return { count: paths.length, sha256: hash(bytes), diffSha256: hash(output("git", ["-C", firefox, "diff", "--binary"])) };
}

export function qualifierSource(repo: string, expectedCommit: string, expectedTree: string) {
  const commit = output("git", ["-C", repo, "rev-parse", "HEAD"]).trim();
  const tree = output("git", ["-C", repo, "rev-parse", "HEAD^{tree}"]).trim();
  assert.equal(commit, expectedCommit, "unexpected verifier commit");
  assert.equal(tree, expectedTree, "unexpected verifier tree");
  assert.equal(output("git", ["-C", repo, "status", "--porcelain"]).trim(), "", "verifier checkout is not clean");
  const files = ["spidermonkey/check-build.ts", "spidermonkey/native-profile.ts", "spidermonkey/native-source-closure.ts"].map(path => {
    const sha256 = fileHash(join(repo, path));
    assert.equal(sha256, hash(output("git", ["-C", repo, "show", `${commit}:${path}`])), `verifier bytes differ from commit: ${path}`);
    return { path, sha256 };
  });
  return { commit, tree, files };
}

function verifierProvenance(expectedCommit: string, expectedTree: string): Record<string, unknown> {
  const repo = dirname(recipe);
  const source = qualifierSource(repo, expectedCommit, expectedTree);
  output("git", ["-C", repo, "merge-base", "--is-ancestor", correctedVerifierHead, "HEAD"]);
  return { correctionBase: { commit: correctedVerifierHead, tree: correctedVerifierTree }, ...source };
}

export function checkRecordedObjectClosure(objects: readonly string[], members: readonly ArchiveMember[], manifest: string): void {
  const value: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  assert(Array.isArray(value), "invalid retained object manifest");
  const records = value.map((entry: unknown) => {
    assert(record(entry) && typeof entry.path === "string" && typeof entry.sha256 === "string" && typeof entry.bytes === "number");
    return { path: entry.path, sha256: entry.sha256, bytes: entry.bytes };
  });
  assert.equal(new Set(objects).size, objects.length, "duplicate archive object path");
  assert.deepEqual(records.map(entry => entry.path).sort(), objects.toSorted(), "archive object list differs from authenticated manifest");
  const expected = records.map(entry => JSON.stringify([basename(entry.path), entry.bytes, entry.sha256])).sort();
  const actual = members.map(member => JSON.stringify([member.name, member.bytes.length, hash(member.bytes)])).sort();
  assert.deepEqual(actual, expected, "archive members differ from authenticated objects");
}

export function assertExternalOutput(outputPath: string, protectedRoots: readonly string[]): void {
  const canonicalOutput = join(realpathSync(dirname(outputPath)), basename(outputPath));
  for (const root of protectedRoots) {
    const canonicalRoot = realpathSync(root);
    assert(canonicalOutput !== canonicalRoot && !canonicalOutput.startsWith(canonicalRoot + "/"), "artifact-only output must be outside protected roots");
  }
}

function artifactOnly(root: string, originalSource: string, evidence: string, outputPath: string, expectedCommit: string, expectedTree: string): void {
  for (const name of ["vm-library.json", "headers.json"]) assert(!existsSync(join(root, "receipt", name)), `native success receipt exists: ${name}`);
  const verifier = verifierProvenance(expectedCommit, expectedTree);
  assert.equal(fileHash(join(evidence, "REPORT.md")), originalFailureReportSha256, "original failure report changed");
  assert.equal(fileHash(join(evidence, "exit-code.txt")), originalFailureExitSha256, "original failure exit changed");
  assert(resolve(root) !== resolve(originalSource), "artifact and original source roots must be distinct");
  assertExternalOutput(outputPath, [root, originalSource, evidence, dirname(requiredBaseline()), dirname(recipe)]);
  const sdk = process.env.WASI_SDK_PATH;
  const sysroot = process.env.BUN_WASM_SYSROOT;
  assert(sdk && sysroot, "source env.sh before artifact-only qualification");
  const retainedInputs = join(evidence, "retained-input-identities.json");
  const retainedObjects = join(evidence, "retained-archive-objects.json");
  const diagnosticHeaders = join(evidence, "diagnostic-headers.json");
  const inputManifest = verifyRecordedFiles(retainedInputs, root, retainedInputsSha256, 10);
  const objectManifest = verifyRecordedFiles(retainedObjects, root, retainedObjectsSha256, 179);
  assert.equal(fileHash(join(root, "libspidermonkey_bunwasm.a")), originalArchiveSha256);
  assert.equal(statSync(join(root, "libspidermonkey_bunwasm.a")).size, originalArchiveBytes);
  assert.equal(fileHash(join(root, "receipt/native-profile.json")), originalProfileSha256);
  const profile = verifyOriginalProfile(root, originalSource);
  verifyOverlayFiles(root);
  const source = verifyOriginalSource(root);
  assert.equal(source.sha256, "51b393e26d98111d5b5fbc98564590f1e57c01a2c8a65bb11d3bc60a193aef63");
  const rawCommands: unknown = JSON.parse(readFileSync(join(root, "obj/clangd/compile_commands.json"), "utf8"));
  assert.equal(fileHash(join(root, "compile_commands.json")), fileHash(join(root, "obj/clangd/compile_commands.json")), "compile command copies differ");
  const targetCommands = checkCommands(rawCommands, sdk, sysroot);
  assert.equal(targetCommands, 535, "unexpected target recipe count");
  const target = output(join(sdk, "bin/clang"), ["-print-target-triple"]).trim();
  assert.equal(target, "wasm32-unknown-wasip1");
  const confdefs = join(root, "obj/js/src/js-confdefs.h");
  const header = readFileSync(confdefs, "utf8");
  for (const name of ["ENABLE_PORTABLE_BASELINE_INTERP", "JS_CODEGEN_NONE", "JS_NUNBOX32"]) {
    assert(new RegExp(`^#define ${name} 1$`, "m").test(header), `missing ${name}`);
  }
  assert(!/^#define ENABLE_PORTABLE_BASELINE_INTERP_FORCE /m.test(header), "PBL must remain selectable");
  assert(!/^#define (?:JS_HAS_INTL_API|JS_HAS_SHARED_MEMORY|JS_JIT) /m.test(header), "forbidden native profile");
  const irregexpUnits = checkUnicodeCommands(commands(rawCommands), root);
  const library = join(root, "libspidermonkey_bunwasm.a");
  const archive = readFileSync(library);
  const archiveInfo = checkArchive(archive);
  const objects = readFileSync(join(root, "receipt/archive-objects.txt"), "utf8").trim().split("\n");
  assert.equal(objects.length, 179);
  const members = archiveMembers(archive);
  checkRecordedObjectClosure(objects, members, retainedObjects);
  const closure = checkIrregexpClosure({ root, sources: irregexpUnits, objects, members });
  const relocationCounts = checkRelocations(output("llvm-readobj", ["--relocs", library]));
  const headers = headerManifest(root);
  const expectedHeaders: unknown = JSON.parse(readFileSync(diagnosticHeaders, "utf8"));
  assert(Array.isArray(expectedHeaders) && expectedHeaders.length === diagnosticHeadersCount);
  assert.equal(fileHash(diagnosticHeaders), diagnosticHeadersSha256);
  assert.equal(headers.count, diagnosticHeadersCount);
  assert.deepEqual(JSON.parse(headers.bytes), expectedHeaders, "retained header bytes changed");
  const symbols = nativeSymbols(library, requiredBaseline(), sdk);
  const repo = dirname(recipe);
  const originalStatus = output("git", ["-C", originalSource, "status", "--porcelain"]).trim();
  assert.equal(originalStatus, "", "original producer checkout is not clean");
  assert.equal(output("git", ["-C", originalSource, "rev-parse", "HEAD"]).trim(), originalBuildHead);
  assert.equal(output("git", ["-C", originalSource, "rev-parse", "HEAD^{tree}"]).trim(), originalBuildTree);
  const toolPaths = [join(sdk, "bin/clang++"), join(sdk, "bin/clang++.cfg"), join(sdk, "bin/llvm-ar"), join(sdk, "bin/llvm-nm"), join(sysroot, "bun-wasm-sysroot.json")];
  const cbindgen = join(process.env.CARGO_HOME ?? "", "bin/cbindgen");
  const result = {
    status: "VERIFIED_ARTIFACT_ONLY",
    gate: "N1",
    parentAdmission: "not claimed",
    originalBuild: {
      sourceHead: originalBuildHead,
      sourceTree: originalBuildTree,
      provenanceClaim: "retained source/profile/archive custody only; original compiler binary provenance was not captured",
      toolchain: null,
      failureEvidence: { status: "FAILED", reportSha256: originalFailureReportSha256, exitSha256: originalFailureExitSha256 },
      profileSha256: originalProfileSha256,
      archive: { path: library, bytes: archive.length, sha256: hash(archive) },
      source,
      profile,
      retainedInputManifest: inputManifest,
      retainedObjectManifest: objectManifest,
    },
    correctedVerifier: verifier,
    gates: { targetCommands, irregexpUnits: irregexpUnits.length, archive: archiveInfo, closure, relocationCounts, symbols, headers: { scope: "diagnostic header readback; not an admitted native receipt", count: headers.count, sha256: headers.sha256 }, confdefsSha256: fileHash(confdefs), configureStatusSha256: fileHash(join(root, "obj/config.status")), mozconfigSha256: fileHash(join(root, "mozconfig")), target },
    qualificationTools: { scope: "qualification-time diagnostics only; original build toolchain provenance is not claimed", toolchain: toolPaths.map(path => ({ path, sha256: fileHash(path) })), cbindgenSha256: fileHash(cbindgen), compiler: output(join(sdk, "bin/clang++"), ["--version"]).trim() },
    baseline: { path: requiredBaseline(), sha256: fileHash(requiredBaseline()) },
    verifierRecipeSha256: fileHash(join(repo, "spidermonkey/native-profile.ts")),
  };
  writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({ status: result.status, gate: result.gate, archive: result.originalBuild.archive, targetCommands, irregexpUnits: irregexpUnits.length, headers: result.gates.headers, addedRequirements: symbols.added }) + "\n");
}

function main(): void {
  if (process.argv[2] === "--artifact-only") {
    const [root, originalSource, evidence, outputPath, expectedCommit, expectedTree] = process.argv.slice(3);
    assert(root && originalSource && evidence && outputPath && expectedCommit && expectedTree, "usage: node spidermonkey/check-build.ts --artifact-only BUILD_DIR ORIGINAL_SOURCE EVIDENCE_DIR OUTPUT_JSON VERIFIER_COMMIT VERIFIER_TREE");
    artifactOnly(resolve(root), resolve(originalSource), resolve(evidence), resolve(outputPath), expectedCommit, expectedTree);
    return;
  }
  const root = process.argv[2];
  const sdk = process.env.WASI_SDK_PATH;
  const sysroot = process.env.BUN_WASM_SYSROOT;
  assert(root && sdk && sysroot, "usage: source env.sh; node spidermonkey/check-build.ts BUILD_DIR");
  const obj = join(root, "obj");
  const compileCommands = join(obj, "clangd/compile_commands.json");
  const rawCommands: unknown = JSON.parse(readFileSync(compileCommands, "utf8"));
  const targetCommands = checkCommands(rawCommands, sdk, sysroot);
  const revision = output("git", ["-C", join(root, "firefox"), "rev-parse", "HEAD"]).trim();
  assert.equal(revision, pin);
  const target = output(join(sdk, "bin/clang"), ["-print-target-triple"]).trim();
  assert.equal(target, "wasm32-unknown-wasip1");
  const confdefs = join(obj, "js/src/js-confdefs.h");
  const header = readFileSync(confdefs, "utf8");
  for (const name of ["ENABLE_PORTABLE_BASELINE_INTERP", "JS_CODEGEN_NONE", "JS_NUNBOX32"]) {
    assert(new RegExp(`^#define ${name} 1$`, "m").test(header), `missing ${name}`);
  }
  assert(!/^#define ENABLE_PORTABLE_BASELINE_INTERP_FORCE /m.test(header), "PBL must remain selectable");
  assert(!/^#define (?:JS_HAS_INTL_API|JS_HAS_SHARED_MEMORY|JS_JIT) /m.test(header), "forbidden native profile");
  const profile = verifyOverlay(root);
  const irregexpUnits = checkUnicodeCommands(commands(rawCommands), root);
  const packed = process.argv.includes("--verify") ? retainedPack(root) : pack(root, sdk);
  const archive = readFileSync(packed.library);
  const objects = checkArchive(archive);
  const irregexpClosure = checkIrregexpClosure({ root, sources: irregexpUnits, objects: packed.objects, members: archiveMembers(archive) });
  const relocations = output("llvm-readobj", ["--relocs", packed.library]);
  const relocationCounts = checkRelocations(relocations);
  const receipt = {
    gate: "N1", scope: "fresh native library only; not N2, VM execution, G3 or complete ES RegExp", revision,
    source: sourceIdentity(root), ...profile, irregexpUnits, irregexpClosure,
    irregexpBackendSha256: fileHash(join(obj, "js/src/irregexp/backend.mk")),
    toolchain: [join(sdk, "bin/clang++"), join(sdk, "bin/clang++.cfg"), join(sdk, "bin/llvm-ar"), join(sdk, "bin/llvm-nm"), join(sysroot, "bun-wasm-sysroot.json")].map((path) => ({ path, sha256: fileHash(path) })),
    commandInputs: { sdk, sysroot, cargoHome: process.env.CARGO_HOME },
    symbols: nativeSymbols(packed.library, requiredBaseline(), sdk),
    target, compiler: output(join(sdk, "bin/clang++"), ["--version"]).trim(),
    cbindgen: output(join(process.env.CARGO_HOME ?? "", "bin/cbindgen"), ["--version"]).trim(),
    cbindgenSha256: fileHash(join(process.env.CARGO_HOME ?? "", "bin/cbindgen")),
    library: packed.library, bytes: archive.length, sha256: hash(archive), ...objects,
    compileCommandsSha256: fileHash(compileCommands), targetCommandsWithPic: targetCommands,
    headers: headerIdentity(root, process.argv.includes("--verify") ? "verify" : "write"), confdefsSha256: fileHash(confdefs), configureStatusSha256: fileHash(join(obj, "config.status")),
    recipeInputs: ["common.sh", "fetch-spidermonkey.sh", "build.sh", "check-build.ts", "native-profile.ts", "native-source-closure.ts", "check-message-generation.ts", "mozconfig.in"].map((path) => ({ path, sha256: fileHash(join(recipe, path)) })),
    patchSha256: fileHash(join(recipe, "spidermonkey-wasi.patch")), mozconfigSha256: fileHash(join(root, "mozconfig")),
    cargoManifestSha256: fileHash(join(root, "firefox/Cargo.toml")),
    objectLists: packed.inputs.concat(irregexpClosure.inputs).map((path) => ({ path, sha256: fileHash(path) })),
    archiveObjectsSha256: hash(packed.objects.join("\n") + "\n"), relocationCounts,
    exceptionTagSections: 0, exceptionTagImports: 0, nonPicCodeRelocations: 0, absoluteLibcStateRelocations: 0,
    rustStaticlibIncluded: false,
  };
  const receiptPath = join(root, "receipt/vm-library.json");
  if (process.argv.includes("--verify")) assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), receipt, "native receipt changed");
  else writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ gate: receipt.gate, sha256: receipt.sha256, bytes: receipt.bytes, headers: receipt.headers, irregexpUnits: irregexpUnits.length, addedRequirements: receipt.symbols.added, replay: process.argv.includes("--verify") }) + "\n");
}

function requiredBaseline(): string {
  const path = process.env.SPIDERMONKEY_BASELINE_LIB;
  assert(path, "set SPIDERMONKEY_BASELINE_LIB to the immutable G2 native archive");
  return path;
}
function retainedPack(root: string) {
  const saved: unknown = JSON.parse(readFileSync(join(root, "receipt/vm-library.json"), "utf8"));
  assert(record(saved) && Array.isArray(saved.objectLists));
  const inputs = saved.objectLists.map((entry: unknown) => {
    assert(record(entry) && typeof entry.path === "string");
    assert.equal(fileHash(entry.path), entry.sha256);
    return entry.path;
  });
  return { library: join(root, "libspidermonkey_bunwasm.a"), inputs, objects: readFileSync(join(root, "receipt/archive-objects.txt"), "utf8").trim().split("\n") };
}
function sourceIdentity(root: string) {
  const firefox = join(root, "firefox");
  const paths = output("git", ["-C", firefox, "ls-files", "-z"]).split("\0").filter((path) => path && existsSync(join(firefox, path)));
  const manifest = paths.map((path) => ({ path, sha256: fileHash(join(firefox, path)) }));
  const sourceManifest = JSON.stringify(manifest, null, 2) + "\n";
  const sourcePath = join(root, "receipt/mozilla-source.json");
  if (process.argv.includes("--verify")) assert.equal(readFileSync(sourcePath, "utf8"), sourceManifest);
  else writeFileSync(sourcePath, sourceManifest);
  const repo = dirname(recipe);
  return {
    commit: output("git", ["-C", repo, "rev-parse", "HEAD"]).trim(),
    tree: output("git", ["-C", repo, "rev-parse", "HEAD^{tree}"]).trim(),
    diffSha256: hash(output("git", ["-C", repo, "diff", "HEAD", "--binary"])),
    mozillaSourceManifest: { path: sourcePath, count: paths.length, sha256: hash(sourceManifest) },
    mozillaDiffSha256: hash(output("git", ["-C", firefox, "diff", "--binary"])),
    mozillaLockSha256: fileHash(join(firefox, "Cargo.lock")),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
