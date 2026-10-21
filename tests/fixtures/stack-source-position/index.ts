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
function rawModulePosition(site: Pick<NodeJS.CallSite, "getFileName" | "getScriptNameOrSourceURL" | "getEvalOrigin" | "isEval" | "getLineNumber" | "getColumnNumber">, path: string) {
  const file = site.getFileName();
  const evaluated = file == null && site.isEval() && site.getScriptNameOrSourceURL() === path && site.getEvalOrigin() === path;
  if (file !== path && !evaluated) return undefined;
  const headerLines = evaluated ? 2 : 0;
  const line = site.getLineNumber();
  const column = site.getColumnNumber();
  assert.ok(line && Number.isInteger(line) && line > headerLines && column && Number.isInteger(column) && column > 0);
  return { line: line - headerLines, column };
}
function loadObserved(source: string, name: string) {
  assert.ok(name.endsWith(".cjs") && !/\bawait\b/.test(source));
  const path = join(scratch, name);
  const raw: { line: number; column: number }[] = [];
  const prepare = Error.prepareStackTrace;
  assert.ok(prepare);
  Error.prepareStackTrace = (error, sites) => {
    for (const site of sites) {
      const position = rawModulePosition(site, path);
      if (position) raw.push(position);
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
