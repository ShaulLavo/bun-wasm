import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Complete a5df22d9 irregexp moz.build closure for this WASI no-Intl overlay.
export const requiredIrregexpUnits: readonly string[] = [
  "RegExpAPI.cpp",
  "RegExpNativeMacroAssembler.cpp",
  "RegExpShim.cpp",
  "bunwasm-icu/allocator.cpp",
  "bunwasm-icu/generated/special-case.cc",
  "bunwasm-icu/icu_subset.cpp",
  "imported/regexp-ast-printer.cc",
  "imported/regexp-ast.cc",
  "imported/regexp-bytecode-generator.cc",
  "imported/regexp-bytecode-iterator.cc",
  "imported/regexp-bytecode-peephole.cc",
  "imported/regexp-bytecodes.cc",
  "imported/regexp-code-generator.cc",
  "imported/regexp-compiler-tonode.cc",
  "imported/regexp-compiler.cc",
  "imported/regexp-dotprinter.cc",
  "imported/regexp-graph-printer.cc",
  "imported/regexp-interpreter.cc",
  "imported/regexp-macro-assembler-tracer.cc",
  "imported/regexp-macro-assembler.cc",
  "imported/regexp-node-printer.cc",
  "imported/regexp-parser.cc",
  "imported/regexp-printer.cc",
  "imported/regexp-stack.cc",
  "util/UnicodeShim.cpp",
  "util/ZoneShimFFI.cpp"
];
export interface ArchiveMember { readonly name: string; readonly bytes: Buffer }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function owner(root: string, path: string, object: string) {
  const sourceRoot = join(root, "firefox/js/src/irregexp") + "/";
  const absolute = resolve(path);
  assert(absolute.startsWith(sourceRoot), "irregexp source escapes pinned closure");
  return { source: absolute.slice(sourceRoot.length), sourceSha256: hash(readFileSync(absolute)), object };
}
function objectSources(root: string) {
  const directory = join(root, "obj/js/src/irregexp");
  const backend = join(directory, "backend.mk");
  const text = readFileSync(backend, "utf8");
  const unified = text.match(/^UNIFIED_CPPSRCS := (.+)$/m)?.[1]?.split(/\s+/) ?? [];
  const normal = Array.from(text.matchAll(/^CPPSRCS \+= (.+)$/gm), match => match[1]!).filter(value => value !== "$(UNIFIED_CPPSRCS)");
  const owners = normal.map(value => {
    assert(/^\$\(srcdir\)\/[\w/.-]+\.(?:cpp|cc)$/.test(value), "unrecognized irregexp source rule");
    const path = join(root, "firefox/js/src/irregexp", value.slice("$(srcdir)/".length));
    return owner(root, path, join(directory, basename(path).replace(/\.(?:cpp|cc)$/, ".o")));
  });
  const inputs = [backend];
  for (const name of unified) {
    assert(/^Unified_cpp_js_src_irregexp\d+\.cpp$/.test(name), "invalid irregexp unified source");
    const path = join(directory, name);
    inputs.push(path);
    const object = path.replace(/\.cpp$/, ".o");
    const includes = Array.from(readFileSync(path, "utf8").matchAll(/^#include "([^"\n]+\.(?:cpp|cc))"$/gm), match => match[1]!);
    assert(includes.length > 0, "empty irregexp unified source");
    for (const source of includes) owners.push(owner(root, resolve(dirname(path), source), object));
  }
  return { inputs, owners };
}
export function checkIrregexpClosure(value: { root: string; sources: readonly string[]; objects: readonly string[]; members: readonly ArchiveMember[] }) {
  const { inputs, owners } = objectSources(value.root);
  assert.deepEqual(owners.map(entry => entry.source).sort(), value.sources.toSorted(), "source-to-object irregexp closure differs");
  assert.deepEqual(value.sources.toSorted(), requiredIrregexpUnits.toSorted(), "incomplete pinned irregexp source set");
  const recorded = new Set(value.objects);
  const objects = Array.from(new Set(owners.map(entry => entry.object)), path => {
    assert(recorded.has(path), `irregexp object absent from archive closure: ${path}`);
    const members = value.members.filter(member => member.name === basename(path));
    assert.equal(members.length, 1, `missing or duplicate irregexp archive member: ${path}`);
    const bytes = readFileSync(path);
    assert(members[0]?.bytes.equals(bytes), `irregexp archive bytes differ from compiled object: ${path}`);
    return { path, sha256: hash(bytes) };
  });
  return { inputs, sources: owners, objects };
}
