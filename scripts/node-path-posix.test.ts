// Differential check for the guest's pure-JavaScript POSIX `node:path`.
// It loads crates/bunwasm-runtime/src/js/path.ts with a native binding that
// throws, so any POSIX call that still crosses into Wasm fails, and compares
// every result with the host Bun's native `node:path` (the same `bun_node_path`
// algorithms the guest ran before). Lone surrogates and argument errors are
// guest-specific and covered by tests/fixtures/node-path-transport.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

type PathModule = typeof path.posix;

function loadGuestPath(): PathModule {
  const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/path.ts", import.meta.url), "utf8");
  const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__pathFactory = ${source}`);
  const scope: { __pathFactory?: (internal: unknown) => PathModule } = {};
  new Function("globalThis", emitted)(scope);
  const crossing = () => { throw new Error("POSIX path operation crossed into Wasm"); };
  const nodePath = new Proxy({}, { get: () => crossing });
  // Mirrors the captures in crates/bunwasm-runtime/src/js/bootstrap.js.
  const uncurry = (method: Function) => Function.prototype.call.bind(method);
  const stringIntrinsics = {
    charCodeAt: uncurry(String.prototype.charCodeAt), slice: uncurry(String.prototype.slice),
    indexOf: uncurry(String.prototype.indexOf), lastIndexOf: uncurry(String.prototype.lastIndexOf),
  };
  const internal = { native: { nodePath, globMatch: crossing }, stringIsWellFormed: uncurry(String.prototype.isWellFormed), stringIntrinsics };
  const factory = scope.__pathFactory;
  if (!factory) throw new Error("path.ts did not produce a factory");
  return factory(internal);
}

// Every sequence of up to six tokens covers separators, dot segments, dotfiles,
// extensions and backslashes in every position.
function corpus(): string[] {
  const tokens = ["/", ".", "a", "b.c", "\\"];
  const inputs: string[] = [""];
  let layer = [""];
  for (let depth = 0; depth < 6; depth++) {
    layer = layer.flatMap(prefix => tokens.map(token => prefix + token));
    for (const value of layer) inputs.push(value);
  }
  return inputs.concat([
    "/foo/bar//baz/asdf/quux/..", "../../x/./y/", "/a/b/c/../../../../d", "a/b/../../..", "./", "../",
    "/..", "//..", "///a//b", "foo.", ".foo.", "..foo", "foo..", "file.tar.gz", "/dir/.hidden",
    "日本/é/é.txt", "😀/𐀀.😀", "a\0b.txt", "﻿a/﻿b.﻿c", "a".repeat(5000) + "/b.c",
    "dir/".repeat(2000) + "x/../".repeat(2000), "../".repeat(500) + "a/".repeat(500) + "../".repeat(700),
    "/" + "a/b/../".repeat(1000) + "..",
  ]);
}

// A fixed linear congruential sequence keeps the pair sample reproducible.
function sampler(seed: number) {
  let state = seed;
  return (limit: number) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state % limit;
  };
}

const guest = loadGuestPath();
const host = path.posix;
const inputs = corpus();
const suffixes = [undefined, "", ".", "a", "c", ".c", "b.c", "/", "a/", "b.c/"];

function compare(name: keyof PathModule, ...args: unknown[]) {
  const expected = Reflect.apply(Reflect.get(host, name) as Function, host, args);
  const actual = Reflect.apply(Reflect.get(guest, name) as Function, guest, args);
  if (Object.is(actual, expected)) return;
  expect({ name, args, actual }).toEqual({ name, args, actual: expected });
}

test("unary POSIX operations match native Bun", () => {
  for (const input of inputs) {
    for (const name of ["normalize", "isAbsolute", "dirname", "extname", "resolve"] as const) compare(name, input);
    for (const suffix of suffixes) compare("basename", input, suffix);
    expect(guest.parse(input)).toEqual(host.parse(input));
    expect(Object.keys(guest.parse(input))).toEqual(["root", "dir", "base", "ext", "name"]);
  }
});

test("join, resolve and relative match native Bun on sampled pairs", () => {
  const next = sampler(0x5eed);
  for (let i = 0; i < 40000; i++) {
    const left = inputs[next(inputs.length)]!;
    const right = inputs[next(inputs.length)]!;
    const third = inputs[next(inputs.length)]!;
    compare("join", left, right);
    compare("join", left, right, third);
    compare("relative", left, right);
    compare("resolve", left, right);
    compare("resolve", left, "", right, third);
  }
  compare("join");
  compare("resolve");
});

// Recorded from the previous native guest (QuickJS, base 972a04f46) with a
// relative cwd of ".": a result that splits a surrogate pair was an error.
test("relative rejects a split surrogate pair from well-formed inputs", () => {
  const original = process.cwd;
  process.cwd = () => ".";
  try {
    expect(() => guest.relative("a", "😀")).toThrow(new Error("Path string result contains an unpaired surrogate"));
    expect(guest.relative("😀", "a")).toBe("..");
    expect(guest.relative("😀x", "😀y")).toBe("..😀y");
    expect(guest.relative("x", "é")).toBe("..é");
    // An input with a lone surrogate used the lossless route and never threw.
    expect(guest.relative("\ud800", "a")).toBe("..a");
  } finally {
    process.cwd = original;
  }
});

test("replacing public string and array methods does not change results", () => {
  const cases: [keyof PathModule, unknown[]][] = [
    ["isAbsolute", ["/a"]], ["normalize", ["a/../b/./c//"]], ["normalize", ["/x/y"]], ["join", ["/a", "../b", "c/"]],
    ["dirname", ["/a/b//"]], ["basename", ["/a/b.txt", ".txt"]], ["basename", ["/a/b/"]], ["extname", ["/a/b.c"]],
    ["parse", ["/a/b.c"]], ["resolve", ["/a", "b", "../c"]], ["relative", ["/a/b/c", "/a/d"]],
  ];
  const call = (entry: [keyof PathModule, unknown[]]) => Reflect.apply(Reflect.get(guest, entry[0]) as Function, guest, entry[1]);
  const expected = cases.map(call);
  const replaced: [object, PropertyKey][] = [
    [String.prototype, "charCodeAt"], [String.prototype, "slice"], [String.prototype, "indexOf"],
    [String.prototype, "lastIndexOf"], [String.prototype, "split"], [String.prototype, "startsWith"],
    [String.prototype, "endsWith"], [Array.prototype, "push"], [Array.prototype, "pop"], [Array.prototype, "join"],
    [Array.prototype, Symbol.iterator], [Math, "min"],
  ];
  const saved = replaced.map(([owner, key]) => Object.getOwnPropertyDescriptor(owner, key)!);
  const broken = { value: () => { throw new Error("replaced"); }, configurable: true, writable: true };
  // Inherited index accessors intercept writes into new arrays.
  const inherited = { get: () => "inherited", set() {}, configurable: true };
  // Indexed loops only: destructuring and for-of need the replaced iterator.
  let actual: unknown[] = [];
  try {
    for (let i = 0; i < replaced.length; i++) Object.defineProperty(replaced[i]![0], replaced[i]![1], broken);
    for (let i = 0; i < 4; i++) Object.defineProperty(Array.prototype, i, inherited);
    actual = cases.map(call);
  } finally {
    for (let i = 0; i < 4; i++) delete (Array.prototype as unknown as Record<number, unknown>)[i];
    for (let i = 0; i < replaced.length; i++) Object.defineProperty(replaced[i]![0], replaced[i]![1], saved[i]!);
  }
  expect(actual).toEqual(expected);
});

// The previous adapter called `startsWith` and `slice` on whatever a replaced
// `process.cwd` returned, and skipped a falsy one.
test("resolve keeps the previous handling of a replaced process.cwd", () => {
  const original = process.cwd;
  try {
    process.cwd = (() => 42) as unknown as typeof process.cwd;
    expect(() => guest.resolve("file")).toThrow(TypeError);
    process.cwd = (() => new String("/boxed")) as unknown as typeof process.cwd;
    expect(guest.resolve("file")).toBe("/boxed/file");
    process.cwd = (() => "") as unknown as typeof process.cwd;
    expect(guest.resolve("file")).toBe("file");
    process.cwd = (() => null) as unknown as typeof process.cwd;
    expect(guest.resolve("a", "..")).toBe(".");
  } finally {
    process.cwd = original;
  }
});

test("relative and resolve use the current directory for relative inputs", () => {
  for (const [from, to] of [["a", "b"], ["", ""], [".", "/"], ["..", "../x"], ["x/y", "x"], ["/", "a"]]) {
    compare("relative", from, to);
    compare("resolve", from, to);
  }
});
