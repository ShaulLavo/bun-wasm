import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

for (const budget of [undefined, "45"]) test(`discovered WebKit stack controls preserve inputs at ${budget ?? "selected policy"}`, () => {
  const child = spawnSync(process.execPath, [new URL("./fixtures/quickjs-stack-policy.ts", import.meta.url).pathname], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, QUICKJS_STACK_KIB: budget },
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr + child.stdout).toBe(0);
  expect(child.stdout).toContain('"probes":25');
  expect(child.stdout).toContain(`"budget":"${budget ?? "policy"}"`);
});

function fixtureParser(name: string): string {
  const source = readFileSync(new URL(`../tests/fixtures/${name}/index.ts`, import.meta.url), "utf8");
  const start = source.indexOf("function quickjsParser(): boolean {");
  const end = source.indexOf("\n}", start);
  if (start < 0 || end < start) throw new Error(`Parser identity control missing in ${name}`);
  return new Bun.Transpiler({ loader: "ts" }).transformSync(`${source.slice(start, end + 2)}\nquickjsParser();`);
}

function parserError(source: string, message: string): unknown {
  return runInNewContext(source, { SyntaxError, eval: () => { throw new SyntaxError(message); } });
}

for (const name of ["quickjs-parser-deep", "stack-statement-nesting"]) test(`${name} parser identity fails closed`, () => {
  const source = fixtureParser(name);
  expect(parserError(source, "'let' is not a valid lexical identifier")).toBe(true);
  expect(parserError(source, "Unexpected keyword 'let'. Cannot use 'let' as an identifier name for a LexicalDeclaration.")).toBe(false);
  expect(parserError(source, "let is disallowed as a lexically bound name")).toBe(false);
  expect(() => parserError(source, "changed QuickJS fingerprint")).toThrow("Unrecognized parser fingerprint");
  expect(() => runInNewContext(source, { SyntaxError, eval: () => undefined })).toThrow("Invalid lexical declaration was accepted");
});
