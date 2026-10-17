import assert from "node:assert/strict";
import { Transpiler } from "bun";

const t = new Transpiler({ loader: "ts" });
assert.doesNotThrow(() => new Transpiler({ loader: "ts", toJSON() { throw new Error("unexpected options serialization"); } }));
assert.equal(new Transpiler(null).transformSync(""), "");
assert.match(t.transformSync("export const x: number = 1"), /export const x = 1/);
assert.match(await t.transform(new TextEncoder().encode("const y: number = 2")), /const y = 2/);
assert.deepEqual(t.scanImports('import x from "pkg"; const y = import("other");'), [
  { path: "pkg", kind: "import-statement" }, { path: "other", kind: "dynamic-import" },
]);
assert.deepEqual(t.scan('import x from "pkg"; export const answer: number = 42;'), {
  exports: ["answer"], imports: [{ path: "pkg", kind: "import-statement" }],
});
for (const method of ["transformSync", "transform", "scan", "scanImports"]) {
  assert.throws(() => t[method]("", "тsx"), TypeError);
}
assert.throws(() => new Transpiler({ loader: "bad" }), TypeError);
assert.throws(() => new Transpiler({ loader: "json" }), TypeError);
assert.deepEqual(t.scan("{}", "json"), { exports: [], imports: [] });
assert.throws(() => t.transformSync("export const ="), AggregateError);
assert.match(t.transformSync("const ok: boolean = true"), /const ok = true/);
const jsx = new Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "h" } } });
assert.match(jsx.transformSync("const x = <div />"), /h\(/);
console.log("public Bun transpiler");
