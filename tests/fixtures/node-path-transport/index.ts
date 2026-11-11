import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import oracle from "./oracle.json";

const inputs = [
  "", ".", "..", "./", "../", "/", "//", "///", "a//b/../c/", "/a/./b//",
  "a\\b/../c\\", "C:", "C:foo", "C:/", "C:\\foo\\bar.txt", "c:\\FOO\\bar.TXT",
  "D:relative", "\\foo", "\\\\server\\share", "\\\\server\\share\\a.txt",
  "\\\\?\\C:\\a", "\\\\.\\C:\\a", "\\\\?\\UNC\\server\\share\\file",
  ".file", "..file", "file.", "file.tar.gz", "a\0b.txt", "\ufeffa/\ufeffb.\ufeffc",
  "日本/é/e\u0301.txt", "😀/𐀀.😀", "\ud800", "\udfff", "a/\ud800.x", "a/\udfff.x",
  "\ud800\ud800", "\udfff\udfff", "\udfff\ud800", "a😀b.txt",
];
const suffixes = [undefined, "", ".", ".txt", "txt", "b.txt", "\ufeffc", "😀", "\ud800", "\ude00", "\udfff"];
const records: unknown[] = [];

function invoke(namespace: typeof path, name: string, args: readonly unknown[]) {
  return Reflect.apply(Reflect.get(namespace, name), namespace, args);
}

function record(namespace: typeof path, name: string, args: readonly unknown[]) {
  try {
    records.push({ value: invoke(namespace, name, args) });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    records.push({ error: error.name, message: error.message, code: Reflect.get(error, "code") });
  }
}

function unary(namespace: typeof path, input: string) {
  for (const name of ["normalize", "isAbsolute", "dirname", "extname", "parse", "resolve", "toNamespacedPath"]) record(namespace, name, [input]);
  for (const suffix of suffixes) record(namespace, "basename", [input, suffix]);
}

function pairs(namespace: typeof path, left: string) {
  for (const right of inputs) {
    record(namespace, "join", [left, right]);
    record(namespace, "relative", [left, right]);
    record(namespace, "resolve", [left, "", right]);
  }
}

function boxed(log: string[], name: string, result: string, fail = false) {
  return Object.assign(new String("ignored"), { [Symbol.toPrimitive]() {
    log.push(name);
    if (fail) throw new Error(name);
    return result;
  } });
}

function coercions(namespace: typeof path) {
  const log: string[] = [];
  const first = boxed(log, "first", "base");
  const second = boxed(log, "second", "file.txt");
  const throwing = boxed(log, "throwing", "", true);
  const invalid = [undefined, null, Symbol("path"), [], 7, {}, first, throwing];
  for (const value of invalid) {
    for (const name of ["normalize", "isAbsolute", "dirname", "extname", "parse", "resolve", "join"]) record(namespace, name, [value]);
    for (const name of ["basename", "relative", "resolve", "join"]) record(namespace, name, [value, second]);
    record(namespace, "basename", [value, 7]);
    record(namespace, "basename", [value, throwing]);
    record(namespace, "relative", [first, value]);
    record(namespace, "resolve", [value, "/absolute"]);
  }
  record(namespace, "join", [first, second, throwing]);
  record(namespace, "basename", [first, second]);
  record(namespace, "basename", [throwing, second]);
  records.push({ coercions: log });
}

function formats(namespace: typeof path) {
  for (const fields of [
    {}, { root: "/" }, { dir: "x", base: "b" }, { root: "/", name: "😀", ext: "txt" },
    { dir: "\ufeffd", root: "\ufeffr", base: "\ufeffb", ext: "\ufeffe", name: "\ufeffn" },
    { root: "\ud800", name: "\udfff", ext: "\ud800" }, { dir: "a\0b", name: "c\0d", ext: "\0" },
  ]) record(namespace, "format", [fields]);
  const log: string[] = [];
  const object = Object.fromEntries(["root", "dir", "base", "name", "ext"].map(key => [key, boxed(log, `coerce ${key}`, key)]));
  const getters = Object.fromEntries(Object.keys(object).map(key => [key, { get() { log.push(`get ${key}`); return object[key]; } }]));
  record(namespace, "format", [Object.defineProperties({}, getters)]);
  record(namespace, "format", [null]);
  record(namespace, "format", [7]);
  records.push({ formatOrder: log });
}

function cwdTiming(namespace: typeof path) {
  const original = process.cwd;
  const log: string[] = [];
  try {
    for (const cwd of ["/", "relative/cwd", "/\ufeff😀/\ud800"]) {
      process.cwd = () => { log.push(cwd); return cwd; };
      record(namespace, "resolve", []);
      record(namespace, "resolve", ["a", "b"]);
      record(namespace, "resolve", [undefined, "/absolute"]);
      record(namespace, "relative", ["same", "same"]);
      record(namespace, "relative", ["a", "b"]);
    }
  } finally {
    process.cwd = original;
  }
  records.push({ cwdReads: log });
}

function exercise(namespace: typeof path) {
  for (const input of inputs) {
    unary(namespace, input);
    pairs(namespace, input);
  }
  for (const input of ["a".repeat(70001), "\ufeff" + "😀".repeat(35001), "\ud800" + "b".repeat(70001)]) {
    unary(namespace, input);
    record(namespace, "join", [input, "\udfff"]);
    record(namespace, "relative", [input, "other"]);
  }
  record(namespace, "join", []);
  record(namespace, "join", ["\ud800", "\udfff"]);
  record(namespace, "basename", ["😀", "\ude00"]);
  coercions(namespace);
  formats(namespace);
  cwdTiming(namespace);
}

assert.equal(typeof String.prototype.isWellFormed, "function");
const originalCwd = process.cwd;
const originalWellFormed = String.prototype.isWellFormed;
process.cwd = () => "/";
// Public method replacement must not change the adapter's captured intrinsic.
String.prototype.isWellFormed = () => { throw new Error("untrusted isWellFormed"); };
try {
  exercise(path.posix);
  exercise(path.win32);
  for (let i = 0; i < 160; i++) {
    const value = `\ufeff${"😀".repeat(256)}\0${i}.txt`;
    assert.equal(path.basename(`dir/${value}`), value);
    assert.deepEqual(path.parse(value), { root: "", dir: "", base: value, name: value.slice(0, -4), ext: ".txt" });
  }
} finally {
  String.prototype.isWellFormed = originalWellFormed;
  process.cwd = originalCwd;
}
const snapshot = JSON.stringify(records);
if (process.argv.includes("--snapshot")) console.log(snapshot);
const digest = createHash("sha256").update(snapshot).digest("hex");
if (process.argv.includes("--record")) console.log(JSON.stringify({ records: records.length, sha256: digest }));
else assert.deepEqual({ records: records.length, sha256: digest }, oracle);
console.log("node:path complete transport corpus");
