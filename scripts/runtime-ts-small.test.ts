import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript-api";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-ts-small-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Hash the original JavaScript AST at e0c85f29. Ignore only redundant expression parentheses.
const originals = {
  cookie: "5cc1305618ad7b836b36694847306b57aa21a4a6d8bd977ffd3e5901cc21b34f",
  formats: "2e6b5465d602987a9a0a5a455d7ced74ab893db48fc4617cb23cd89d24bae930",
  intl: "74d0927e7dbc59c832d8ede9a6ec7e7ff6a220cd6aa077ed17fc2abff6d66c24",
};

function syntax(text: string): string {
  const source = ts.createSourceFile("runtime.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node: ts.Node): unknown {
    if (ts.isParenthesizedExpression(node)) return visit(node.expression);
    const children = node.getChildren(source);
    return children.length ? [node.kind, children.map(visit)] : [node.kind, node.getText(source)];
  }
  return JSON.stringify(visit(source));
}

for (const [name, hash] of Object.entries(originals)) {
  test(`${name} embeds the original runtime syntax, including strict directives`, () => {
    const output = join(scratch, `${name}.js`);
    const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(root, `crates/bunwasm-runtime/src/js/${name}.ts`), output]);
    expect(result.exitCode).toBe(0);
    const emitted = readFileSync(output, "utf8");
    expect(createHash("sha256").update(syntax(emitted)).digest("hex")).toBe(hash);
  });
}
