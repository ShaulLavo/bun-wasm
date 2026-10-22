import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(`${process.cwd()}/package.json`);
const name = "@next/swc-wasm-nodejs";
const resolved = require.resolve(name);
const expectedSource = "const value: number = 42;";

function transform(compiler: unknown) {
  assert.ok(compiler && typeof compiler === "object" && "transformSync" in compiler && typeof compiler.transformSync === "function");
  const result: unknown = compiler.transformSync(expectedSource, { filename: "probe.ts", jsc: { parser: { syntax: "typescript" } } });
  assert.ok(result && typeof result === "object" && "code" in result && typeof result.code === "string");
  assert.ok(result.code.includes("42") && !result.code.includes(": number"));
  return result.code;
}

const required: unknown = require(name);
const rows: { kind: string; specifier: string; code: string }[] = [{ kind: "require", specifier: resolved, code: transform(required) }];
for (const specifier of [resolved, pathToFileURL(resolved).href]) {
  const imported: unknown = await import(specifier);
  rows.push({ kind: "import", specifier, code: transform(imported) });
}
const unresolved = pathToFileURL(name).href;
let failed = false;
try { await import(unresolved); }
catch (error) {
  assert.ok(error && typeof error === "object" && "code" in error);
  assert.equal(error.code, "ERR_MODULE_NOT_FOUND");
  rows.push({ kind: "Next package-name file URL", specifier: unresolved, code: String(error.code) });
  failed = true;
}
assert.ok(failed, "A package name converted to a cwd file URL must not resolve through node_modules");
process.stdout.write(JSON.stringify({ resolved, rows }) + "\n");
