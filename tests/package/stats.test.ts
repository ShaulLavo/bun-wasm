import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Exercise the production factory, not a reimplementation of its predicates.
// Only module dependencies unrelated to Stats are inert; no filesystem or
// process-global monkeypatch is needed.
const source = await Bun.file(new URL("../../crates/bunwasm-runtime/src/js/node_fs.js", import.meta.url)).text();
const optionsSource = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/fs_options.ts", import.meta.url), "utf8");
const optionsFactory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${optionsSource}`));
const factory = new Function(`return (${source})`)();
const { fs } = factory({
  native: {},
  require(name: string) {
    if (name === "buffer") return { Buffer };
    if (name === "fs_watch") return () => ({});
    if (name === "fs_options") return optionsFactory({});
    throw new Error(`Unexpected Stats fixture dependency: ${name}`);
  },
});
const predicates = ["isFile", "isDirectory", "isSymbolicLink", "isBlockDevice", "isCharacterDevice", "isFIFO", "isSocket"] as const;
for (const [name, kind] of [
  ["isFile", 0o100000], ["isDirectory", 0o040000], ["isSymbolicLink", 0o120000],
  ["isBlockDevice", 0o060000], ["isCharacterDevice", 0o020000], ["isFIFO", 0o010000], ["isSocket", 0o140000],
] as const) {
  test(`production Stats preserves ${name} with permission bits`, () => {
    const stat = new fs.Stats({ mode: kind | 0o640, atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0 });
    for (const predicate of predicates) expect(stat[predicate]()).toBe(predicate === name);
  });
}
