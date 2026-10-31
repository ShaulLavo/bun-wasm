import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function checkArchive(bytes: Buffer): { wasmObjects: number; objectsReferencingMemoryBase: number } {
  assert.equal(bytes.subarray(0, 8).toString(), "!<arch>\n", "expected regular archive");
  let offset = 8;
  let wasmObjects = 0;
  let objectsReferencingMemoryBase = 0;
  while (offset < bytes.length) {
    const name = bytes.subarray(offset, offset + 16).toString().trim();
    const size = Number(bytes.subarray(offset + 48, offset + 58).toString().trim());
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 60 + size <= bytes.length, "invalid archive member");
    const member = bytes.subarray(offset + 60, offset + 60 + size);
    offset += 60 + size + (size % 2);
    if (["/", "//", "/SYM64/"].includes(name)) continue;
    checkObject(member);
    wasmObjects++;
    if (member.includes(Buffer.from("__memory_base"))) objectsReferencingMemoryBase++;
  }
  assert(wasmObjects > 0 && objectsReferencingMemoryBase > 0, "expected PIC Wasm objects");
  return { wasmObjects, objectsReferencingMemoryBase };
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

function headerIdentity(root: string): { count: number; sha256: string } {
  const include = join(root, "obj/dist/include");
  const headers = readdirSync(include, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(?:h|hpp|inc)$/.test(path) && statSync(join(include, path)).isFile());
  headers.sort();
  assert(headers.length > 0, "no exported headers");
  const manifest = headers.map((path) => ({ path, sha256: fileHash(join(include, path)) }));
  const bytes = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(join(root, "receipt/headers.json"), bytes);
  return { count: headers.length, sha256: hash(bytes) };
}

function main(): void {
  const root = process.argv[2];
  const sdk = process.env.WASI_SDK_PATH;
  const sysroot = process.env.BUN_WASM_SYSROOT;
  assert(root && sdk && sysroot, "usage: source env.sh; node spidermonkey/check-build.ts BUILD_DIR");
  const obj = join(root, "obj");
  const compileCommands = join(obj, "clangd/compile_commands.json");
  const commands: unknown = JSON.parse(readFileSync(compileCommands, "utf8"));
  const targetCommands = checkCommands(commands, sdk, sysroot);
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
  const packed = pack(root, sdk);
  const archive = readFileSync(packed.library);
  const objects = checkArchive(archive);
  const relocations = output("llvm-readobj", ["--relocs", packed.library]);
  const relocationCounts = checkRelocations(relocations);
  const receipt = {
    gate: "G1", scope: "library build only, not runtime correctness", revision,
    target, compiler: output(join(sdk, "bin/clang++"), ["--version"]).trim(),
    cbindgen: output(join(process.env.CARGO_HOME ?? "", "bin/cbindgen"), ["--version"]).trim(),
    cbindgenSha256: fileHash(join(process.env.CARGO_HOME ?? "", "bin/cbindgen")),
    library: packed.library, bytes: archive.length, sha256: hash(archive), ...objects,
    compileCommandsSha256: fileHash(compileCommands), targetCommandsWithPic: targetCommands,
    headers: headerIdentity(root), confdefsSha256: fileHash(confdefs), configureStatusSha256: fileHash(join(obj, "config.status")),
    recipeInputs: ["common.sh", "fetch-spidermonkey.sh", "build.sh", "check-build.ts", "mozconfig.in"].map((path) => ({ path, sha256: fileHash(join(recipe, path)) })),
    patchSha256: fileHash(join(recipe, "spidermonkey-wasi.patch")), mozconfigSha256: fileHash(join(root, "mozconfig")),
    cargoManifestSha256: fileHash(join(root, "firefox/Cargo.toml")),
    objectLists: packed.inputs.map((path) => ({ path, sha256: fileHash(path) })),
    archiveObjectsSha256: hash(packed.objects.join("\n") + "\n"), relocationCounts,
    exceptionTagSections: 0, exceptionTagImports: 0, nonPicCodeRelocations: 0, absoluteLibcStateRelocations: 0,
    rustStaticlibIncluded: false,
  };
  writeFileSync(join(root, "receipt/vm-library.json"), JSON.stringify(receipt, null, 2) + "\n");
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
