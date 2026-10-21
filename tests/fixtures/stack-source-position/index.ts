import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { newTokenLength, verifyMappedStackSource, verifyRawStackSources, verifyStackSources } from "./contract.ts";

const require = createRequire(import.meta.url);
const original = Error.prepareStackTrace;
const scratch = mkdtempSync(join(process.cwd(), "stack-source-"));
function nodeOracle(_error: Error, sites: NodeJS.CallSite[]): string {
  const site = sites[0];
  assert.ok(site);
  const file = site.getFileName();
  const line = site.getLineNumber();
  const column = site.getColumnNumber();
  assert.ok(file && line && column);
  const text = readFileSync(file, "utf8").split("\n")[line - 1];
  assert.notEqual(text, undefined);
  return `${file}:${line}:${column + newTokenLength(text ?? "", column)}`;
}
function load(source: string, name: string) {
  const path = join(scratch, name);
  writeFileSync(path, source);
  const error: unknown = require(path);
  assert.ok(error instanceof Error);
  const frame = String(error.stack).split("\n").find(line => line.includes(path));
  const match = frame?.match(/:(\d+):(\d+)\)?$/);
  assert.ok(match, `source frame missing for ${name}: ${error.stack}`);
  return { line: Number(match[1]), column: Number(match[2]) };
}
function loadObserved(source: string, name: string) {
  const path = join(scratch, name);
  const raw: { line: number; column: number }[] = [];
  const prepare = Error.prepareStackTrace;
  assert.ok(prepare);
  Error.prepareStackTrace = (error, sites) => {
    for (const site of sites) {
      if (site.getFileName() !== path) continue;
      const line = site.getLineNumber();
      const column = site.getColumnNumber();
      assert.ok(line && column);
      raw.push({ line, column });
    }
    return Reflect.apply(prepare, Error, [error, sites]);
  };
  try { return { raw, formatted: load(source, name) }; }
  finally { Error.prepareStackTrace = prepare; }
}
try {
  // Node's raw V8 columns are the oracle for this existing Bun-format adjustment.
  if (typeof Bun === "undefined") Error.prepareStackTrace = nodeOracle;
  verifyStackSources(load);
  verifyMappedStackSource(load);
  verifyRawStackSources(loadObserved);
  console.log("Stack constructor columns preserve UTF-16, whitespace, huge lines and mapped TypeScript");
} finally {
  Error.prepareStackTrace = original;
  rmSync(scratch, { recursive: true, force: true });
}
