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
  const internal = { native: { nodePath, globMatch: crossing }, stringIsWellFormed: (value: string) => value.isWellFormed() };
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

test("relative and resolve use the current directory for relative inputs", () => {
  for (const [from, to] of [["a", "b"], ["", ""], [".", "/"], ["..", "../x"], ["x/y", "x"], ["/", "a"]]) {
    compare("relative", from, to);
    compare("resolve", from, to);
  }
});
