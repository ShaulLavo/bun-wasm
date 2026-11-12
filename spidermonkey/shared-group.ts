/**
 * Pack and check the shared-group SpiderMonkey library, then stage the inputs a group side links.
 * The split checker (check-build.ts) stays the authority for the split archive; this one accepts
 * only an atomics build that carries the group port. Provenance:
 * docs/bun-patches/spidermonkey-shared-group.md.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { targetFeatures, verifySharedSysroot } from "../scripts/src/program-profile.ts";
import { archiveMembers, checkArchive, checkCommands, checkRelocations, headerIdentity, supportObjectNames } from "./check-build.ts";
import { pin, symbolSets, verifyOverlay } from "./native-profile.ts";

import { verifyDiagnosticProfile } from "./diagnostic-profile.ts";

const recipe = dirname(fileURLToPath(import.meta.url));
const fileHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const output = (program: string, args: string[]) => execFileSync(program, args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });

export const groupFlags: readonly string[] = ["-matomics", "-mbulk-memory", "-mmutable-globals", "-DBUN_WASM_SHARED_GROUP=1"];
/** What the group port asks of the core: the single futex and the region ledger. */
export const groupImports: readonly string[] = ["bun_futex_wait32", "bun_futex_wait64", "bun_futex_wake", "bun_shared_buffer_alloc", "bun_shared_buffer_release"];
export const groupRegionConstructor = "_ZN2JS35NewSharedArrayBufferOverGroupRegionEP9JSContextPhm";

/** Every target compile command carries the group flags; one object without atomics breaks the link. */
export function checkGroupCommands(raw: unknown, sdk: string): number {
  assert(Array.isArray(raw), "compile commands must be an array");
  let checked = 0;
  for (const entry of raw) {
    assert(entry && typeof entry === "object" && "arguments" in entry && "file" in entry && Array.isArray(entry.arguments));
    const args: unknown[] = entry.arguments;
    if (typeof args[0] !== "string" || !args[0].startsWith(join(sdk, "bin") + "/")) continue;
    for (const flag of groupFlags) assert(args.includes(flag), `missing ${flag}: ${String(entry.file)}`);
    checked++;
  }
  assert(checked > 0, "no target compile commands");
  return checked;
}

/** wasm-ld refuses any member that lacks atomics or disallows shared memory under --shared-memory. */
export function checkGroupFeatures(members: readonly { name: string; bytes: Uint8Array }[]): void {
  for (const member of members) {
    const features = targetFeatures(member.bytes);
    assert(features.includes("+atomics"), `object built without atomics: ${member.name}`);
    assert(!features.includes("-shared-mem"), `object disallows shared memory: ${member.name}`);
  }
}

/** The library must define the region constructor and leave exactly the core's group symbols open. */
export function checkGroupSymbols(text: string): void {
  const { defined, undefinedSymbols } = symbolSets(text);
  assert(defined.has(groupRegionConstructor), "missing the group-region SharedArrayBuffer constructor");
  for (const name of groupImports) assert(undefinedSymbols.has(name) && !defined.has(name), `missing core requirement: ${name}`);
  const unexpected = Array.from(undefinedSymbols).filter(name => /^bun_/.test(name) && !defined.has(name) && !groupImports.includes(name));
  assert.deepEqual(unexpected, [], "undocumented core requirement");
}

/** The split archive's object closure: the JS static list plus the support directories' objects. */
function packLibrary(root: string, sdk: string): string {
  const obj = join(root, "obj");
  const listed = readFileSync(join(obj, "js/src/build/libjs_static_a.list"), "utf8").trim().split(/\r?\n/);
  const support = ["memory/build", "memory/mozalloc", "mfbt", "mozglue/misc", "mozglue/baseprofiler", "third_party/fmt"]
    .flatMap(dir => supportObjectNames(readFileSync(join(obj, dir, "backend.mk"), "utf8")).map(name => join(obj, dir, name)));
  const objects = Array.from(new Set(listed.concat(support)));
  assert(support.length > 0 && objects.every(path => path.startsWith(obj + "/") && path.endsWith(".o") && existsSync(path)), "invalid archive object closure");
  const list = join(root, "receipt/shared-group-objects.txt");
  writeFileSync(list, objects.join("\n") + "\n");
  const library = join(root, "libspidermonkey_bunwasm.a");
  writeFileSync(library, "!<arch>\n");
  output(join(sdk, "bin/llvm-ar"), ["rcs", library, "@" + list]);
  return library;
}

function stage(root: string, library: string): string {
  const native = join(root, "native");
  assert(!existsSync(native), "staged native inputs exist; use a fresh build directory");
  mkdirSync(native);
  // Exported headers are links into the source tree. A side build reads real files.
  cpSync(join(root, "obj/dist/include"), join(native, "include"), { recursive: true, dereference: true });
  copyFileSync(join(root, "obj/js/src/js-confdefs.h"), join(native, "js-confdefs.h"));
  copyFileSync(library, join(native, "libspidermonkey_bunwasm.a"));
  return native;
}

function main(): void {
  const root = process.argv[2] && resolve(process.argv[2]);
  const sdk = process.env.WASI_SDK_PATH;
  const sysroot = process.env.BUN_WASM_SYSROOT;
  assert(root && sdk && sysroot, "usage: source env.sh; node spidermonkey/shared-group.ts BUILD_DIR");
  assert.equal(process.env.BUN_WASM_SHARED_SYSROOT, sysroot, "shared-group builds use the shared-pic sysroot");
  const sharedSysroot = verifySharedSysroot(sysroot);
  const obj = join(root, "obj");
  const firefox = join(root, "firefox");
  assert.equal(output("git", ["-C", firefox, "rev-parse", "HEAD"]).trim(), pin);
  for (const patch of ["spidermonkey-wasi.patch", "spidermonkey-shared-group.patch"]) {
    output("git", ["-C", firefox, "apply", "--reverse", "--check", join(recipe, patch)]);
  }
  verifyOverlay(root);
  const rawCommands: unknown = JSON.parse(readFileSync(join(obj, "clangd/compile_commands.json"), "utf8"));
  const targetCommands = checkCommands(rawCommands, sdk, sysroot);
  assert.equal(checkGroupCommands(rawCommands, sdk), targetCommands, "every target command is a group command");
  const header = readFileSync(join(obj, "js/src/js-confdefs.h"), "utf8");
  for (const name of ["ENABLE_PORTABLE_BASELINE_INTERP", "JS_CODEGEN_NONE", "JS_NUNBOX32"]) {
    assert(new RegExp(`^#define ${name} 1$`, "m").test(header), `missing ${name}`);
  }
  assert(!/^#define ENABLE_PORTABLE_BASELINE_INTERP_FORCE /m.test(header), "PBL must remain selectable");
  const library = packLibrary(root, sdk);
  const archive = readFileSync(library);
  const objects = checkArchive(archive);
  checkGroupFeatures(archiveMembers(archive));
  checkGroupSymbols(output(join(sdk, "bin/llvm-nm"), ["--format=posix", library]));
  const relocationCounts = checkRelocations(output("llvm-readobj", ["--relocs", library]));
  const diagnostics = verifyDiagnosticProfile(root, sdk, sysroot);
  const receipt = {
    scope: "shared-group native library; experimental, not a publication input",
    profile: "shared-group", diagnostics, revision: pin, flags: groupFlags, sharedSysroot,
    patches: ["spidermonkey-wasi.patch", "spidermonkey-shared-group.patch"].map(path => ({ path, sha256: fileHash(join(recipe, path)) })),
    mozconfigSha256: fileHash(join(root, "mozconfig")),
    confdefsSha256: fileHash(join(obj, "js/src/js-confdefs.h")),
    compiler: output(join(sdk, "bin/clang++"), ["--version"]).trim(),
    library: { bytes: archive.length, sha256: createHash("sha256").update(archive).digest("hex"), ...objects },
    targetCommands, relocationCounts, headers: headerIdentity(root), coreRequirements: groupImports,
  };
  writeFileSync(join(root, "receipt/shared-group-library.json"), JSON.stringify(receipt, null, 2) + "\n");
  const native = stage(root, library);
  const stagedDiagnostics = verifyDiagnosticProfile(root, sdk, sysroot, join(native, "include"), join(native, "js-confdefs.h"));
  assert.deepEqual(stagedDiagnostics.embedding.macros, diagnostics.embedding.macros, "staged embedding macros differ");
  assert.equal(stagedDiagnostics.confdefsSha256, diagnostics.confdefsSha256);
  copyFileSync(join(root, "receipt/shared-group-library.json"), join(native, "shared-group-library.json"));
  process.stdout.write(JSON.stringify({ profile: receipt.profile, library: receipt.library, headers: receipt.headers, native }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
