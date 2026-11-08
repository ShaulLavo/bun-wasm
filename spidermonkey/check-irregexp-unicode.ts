// C0: inventory the pinned source without compiling or changing its native tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const read = (path: string) => readFileSync(path, "utf8");
const api = ["size", "contains", "containsSome", "containsNone", "containsAll", "remove", "removeAll", "retainAll",
  "add", "addAll", "complement", "closeOver", "applyIntPropertyValue", "getRangeCount", "getRangeStart", "getRangeEnd",
  "hasStrings", "removeAllStrings", "freeze", "skipToStrings", "next", "getString", "getBuffer", "length"];
const classes = new Set(["UnicodeSet", "UnicodeSetIterator", "UnicodeString"]);
const functions = new Set(["u_foldCase", "u_isalpha", "u_getPropertyEnum", "u_getPropertyValueEnum",
  "u_getPropertyName", "u_getPropertyValueName"]);
const headers = new Set(["uchar.h", "uniset.h", "unistr.h", "usetiter.h", "utf16.h", "utypes.h", "locid.h"]);

function files(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" }).sort()
    .filter((path) => statSync(join(directory, path)).isFile());
}
function identity(path: string) {
  const bytes = readFileSync(path);
  return { path, sha256: hash(bytes), bytes: bytes.length };
}
function sourceInventory(root: string, paths: readonly string[]) {
  return paths.map((path) => {
    const source = read(join(root, path));
    const uses = Array.from(source.matchAll(/\b(?:V8_INTL_SUPPORT|JS_HAS_INTL_API)\b/g), (match) => ({
      line: source.slice(0, match.index).split("\n").length, token: match[0],
    }));
    return { ...identity(join(root, path)), uses };
  });
}
function checkCompiled(source: string, path: string) {
  for (const match of source.matchAll(/\bicu::(\w+)/g)) assert(classes.has(match[1] ?? ""), `unlisted ICU type in ${path}: ${match[0]}`);
  for (const match of source.matchAll(/\b(u_\w+)\s*\(/g)) assert(functions.has(match[1] ?? ""), `unlisted ICU function in ${path}: ${match[0]}`);
  for (const match of source.matchAll(/#\s*include "unicode\/([^"]+)"/g)) assert(headers.has(match[1] ?? ""), `unlisted ICU header in ${path}: ${match[0]}`);
}
function main() {
  const root = process.argv[2];
  assert(root, "usage: check-irregexp-unicode.ts PINNED_FIREFOX_SOURCE");
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(head, "a5df22d986d4b626f771b4f8885241941601c35c");
  const build = read(join(root, "js/src/irregexp/moz.build"));
  const units = Array.from(build.matchAll(/^\s+"([^"]+\.(?:cc|cpp))",/gm), (match) => {
    assert(match[1]); return `js/src/irregexp/${match[1]}`;
  });
  assert(!units.some((path) => path.includes("gen-regexp-special-case")), "generator is not a compiled unit");
  assert(units.includes("js/src/irregexp/imported/special-case.cc"));
  assert(units.includes("js/src/irregexp/util/ZoneShimFFI.cpp"));
  const sourcePaths = files(join(root, "js/src/irregexp"))
    .filter((path) => /\.(?:cc|cpp|h)$/.test(path)).map((path) => `js/src/irregexp/${path}`);
  for (const path of units) checkCompiled(read(join(root, path)), path);
  checkCompiled(read(join(root, "js/src/irregexp/imported/special-case.h")), "special-case.h");
  const adapterFiles = files("spidermonkey/irregexp-icu").map((path) => `spidermonkey/irregexp-icu/${path}`);
  const declarations = read("spidermonkey/irregexp-icu/include/unicode/uniset.h") +
    read("spidermonkey/irregexp-icu/include/unicode/unistr.h") + read("spidermonkey/irregexp-icu/include/unicode/usetiter.h");
  for (const method of api) assert(new RegExp(`\\b${method}\\s*\\(`).test(declarations), `missing adapter signature: ${method}`);
  const enumHeader = read("spidermonkey/irregexp-icu/include/unicode/uchar.h") + read("spidermonkey/irregexp-icu/include/unicode/utypes.h");
  const parser = read(join(root, "js/src/irregexp/imported/regexp-parser.cc"));
  const constants = Array.from(new Set(Array.from(parser.matchAll(/\bUCHAR_\w+/g), (match) => match[0]))).sort();
  for (const name of constants) assert(enumHeader.includes(name), `missing property constant: ${name}`);
  const result = {
    gate: "C0", sourceRoot: root, revision: head,
    compiledUnits: units.map((path) => identity(join(root, path))),
    conditionalSites: sourceInventory(root, sourcePaths).filter((item) => item.uses.length),
    adapterSignatures: api, propertyConstants: constants,
    exactAliasReplacement: "The WASI patch replaces ICU4C alias-enumeration calls with strict predicates.",
    emptySetCorrection: "The WASI parser arm tests U_FAILURE only, never successful set contents.",
    excludedGenerator: identity(join(root, "js/src/irregexp/imported/gen-regexp-special-case.cc")),
    adapterFiles: adapterFiles.map(identity),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
main();
