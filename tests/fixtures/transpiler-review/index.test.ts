import assert from "node:assert/strict";
import { test } from "bun:test";

test("async transforms own the selected byte range", async () => {
  const source = new TextEncoder().encode("const x=1");
  const storage = new Uint8Array(source.length + 6);
  storage.fill(32);
  storage.set(source, 3);
  const pending = new Bun.Transpiler().transform(storage.subarray(3, 3 + source.length));
  storage.fill(32);
  assert.equal(await pending, "const x = 1;\n");
  const view = new DataView(new TextEncoder().encode("const y=2").buffer);
  const other = new Bun.Transpiler().transform(view);
  new Uint8Array(view.buffer).fill(32);
  assert.equal(await other, "const y = 2;\n");
  const detached = new Uint8Array(new ArrayBuffer(9));
  detached.set(new TextEncoder().encode("const z=3"));
  const last = new Bun.Transpiler().transform(detached);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  assert.equal(detached.byteLength, 0);
  assert.equal(await last, "const z = 3;\n");
});

test("minify boolean and object options configure the real printer", () => {
  const code = "const longName = 1; console.log(longName);";
  assert.equal(new Bun.Transpiler({ minify: true }).transformSync(code), "const o=1;console.log(o);");
  assert.equal(new Bun.Transpiler({ minify: { identifiers: true } }).transformSync(code), "const o = 1;\nconsole.log(o);\n");
  assert.equal(new Bun.Transpiler({ minify: { whitespace: true } }).transformSync(code), "const longName=1;console.log(longName);");
  assert.equal(new Bun.Transpiler({ minify: { syntax: true } }).transformSync("const x = true; console.log(x);"), "const x = !0;\nconsole.log(x);\n");
  assert.equal(new Bun.Transpiler({ minify: false }).transformSync(code), "const longName = 1;\nconsole.log(longName);\n");
  assert.equal(new Bun.Transpiler({ minify: { identifiers: 1 } }).transformSync(code), "const o = 1;\nconsole.log(o);\n");
  assert.equal(new Bun.Transpiler({ minifyWhitespace: true, minify: { whitespace: null } }).transformSync(code), "const longName = 1;\nconsole.log(longName);\n");
  for (const minify of [0, 1, "yes"]) {
    assert.throws(() => new Bun.Transpiler({ minify }), { name: "TypeError", message: "Expected minify to be a boolean or an object" });
  }
});

test("public TypeScript transforms preserve unused imports by default", () => {
  const source = 'import { sideEffect } from "pkg"; export const x: number=1;';
  for (const options of [{}, { treeShaking: true, trimUnusedImports: false }]) {
    const transpiler = new Bun.Transpiler({ loader: "ts", ...options });
    assert.equal(transpiler.transformSync(source), 'import { sideEffect } from "pkg";\nexport const x = 1;\n');
    assert.deepEqual(transpiler.scan(source), { exports: ["x"], imports: [{ kind: "import-statement", path: "pkg" }] });
  }
  for (const options of [{ treeShaking: true }, { trimUnusedImports: true }]) {
    const transpiler = new Bun.Transpiler({ loader: "ts", ...options });
    assert.equal(transpiler.transformSync(source), "export const x = 1;\n");
    assert.deepEqual(transpiler.scan(source), { exports: ["x"], imports: [] });
  }
});
