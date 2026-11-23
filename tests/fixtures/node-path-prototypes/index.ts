// POSIX node:path runs on string intrinsics that bootstrap captures before user
// code, so replacing public prototype methods or adding inherited index
// accessors after startup cannot change its results.
import assert from "node:assert/strict";
import path from "node:path";

const posix = path.posix;
function results(): string {
  // String concatenation only: arrays and their methods are replaced below.
  return posix.normalize("a/../b/./c//") + "|" + posix.join("a", "../b", "c/") + "|" + posix.dirname("/a/b//") + "|" +
    posix.basename("/a/b.txt", ".txt") + "|" + posix.extname("/a/b.c") + "|" + posix.parse("/a/b.c").name + "|" +
    posix.resolve("/a", "b", "../c") + "|" + posix.relative("/a/b/c", "/a/d") + "|" + String(posix.isAbsolute("/a"));
}

const expected = results();
const owners = [String.prototype, String.prototype, String.prototype, String.prototype, String.prototype,
  Array.prototype, Array.prototype, Array.prototype, Array.prototype, Array.prototype, Array.prototype];
const keys: PropertyKey[] = ["charCodeAt", "slice", "indexOf", "lastIndexOf", "split",
  "push", "pop", "join", "map", "reverse", Symbol.iterator];
const saved = keys.map((key, index) => Object.getOwnPropertyDescriptor(owners[index]!, key)!);
const broken = { value: () => { throw new Error("replaced"); }, configurable: true, writable: true };
const inherited = { get: () => "inherited", set() {}, configurable: true };
let actual = "";
try {
  for (let i = 0; i < keys.length; i++) Object.defineProperty(owners[i]!, keys[i]!, broken);
  for (let i = 0; i < 4; i++) Object.defineProperty(Array.prototype, i, inherited);
  actual = results();
} finally {
  for (let i = 0; i < 4; i++) delete (Array.prototype as unknown as Record<number, unknown>)[i];
  for (let i = 0; i < keys.length; i++) Object.defineProperty(owners[i]!, keys[i]!, saved[i]!);
}
assert.equal(actual, expected);
assert.equal(expected, "b/c/|b/c/|/a|b|.c|b|/a/c|../../d|true");
console.log("node:path POSIX results ignore replaced prototypes");
