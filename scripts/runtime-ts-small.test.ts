import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runtimeSyntax } from "./runtime-syntax";
import ts from "typescript-api";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-ts-small-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Pin the original ASTs at e0c85f29, and SQLite at ac43127c. Ignore only redundant expression parentheses.
const originals = {
  bun_sqlite: "b16a65d13a67fecf1c3f847afcdc26bc3430762ddb75653244bf3820ebebb6e0",
  cookie: "5cc1305618ad7b836b36694847306b57aa21a4a6d8bd977ffd3e5901cc21b34f",
  formats: "2e6b5465d602987a9a0a5a455d7ced74ab893db48fc4617cb23cd89d24bae930",
  intl: "74d0927e7dbc59c832d8ede9a6ec7e7ff6a220cd6aa077ed17fc2abff6d66c24",
};

for (const [name, hash] of Object.entries(originals)) {
  test(`${name} embeds the original runtime syntax, including strict directives`, () => {
    const output = join(scratch, `${name}.js`);
    const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(root, `crates/bunwasm-runtime/src/js/${name}.ts`), output]);
    expect(result.exitCode).toBe(0);
    const emitted = readFileSync(output, "utf8");
    expect(createHash("sha256").update(runtimeSyntax(emitted)).digest("hex")).toBe(hash);
  });
}

test("SQLite preserves each emitted runtime token's TypeScript source position", () => {
  const source = join(root, "crates/bunwasm-runtime/src/js/bun_sqlite.ts");
  const output = join(scratch, "sqlite.js");
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), source, output]);
  expect(result.exitCode).toBe(0);
  const original = readFileSync(source, "utf8").split("\n");
  const emitted = readFileSync(output, "utf8");
  const parsed = ts.createSourceFile("sqlite.js", emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  expect(emitted.split("\n").length).toBe(original.length);
  function visit(node: ts.Node) {
    const children = node.getChildren(parsed);
    if (children.length) return children.forEach(visit);
    const start = node.getStart(parsed);
    const { line, character } = parsed.getLineAndCharacterOfPosition(start);
    expect(original[line]?.slice(character, character + node.getWidth(parsed))).toBe(node.getText(parsed));
  }
  visit(parsed);
});
