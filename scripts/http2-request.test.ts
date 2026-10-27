import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInContext } from "node:vm";
import { runOwned, sourceModuleTools, sourceRuntime } from "./fixtures/stream-consumers-runtime";

const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-http2-request-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fixture = join(import.meta.dirname, "../tests/fixtures/http2-request/index.ts");

test("native Bun request compatibility contract", () => {
  const result = runOwned("bun", [fixture]);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(readFileSync(join(fixture, "../expected.txt"), "utf8"));
});

test("actual builtin source supplies the request class and stream lifecycle", async () => {
  const source = sourceRuntime(scratch);
  const control = readFileSync(fixture, "utf8")
    .replace('import assert from "node:assert/strict";', 'const assert = require("node:assert/strict");')
    .replace('import http2, { Http2ServerRequest, constants } from "node:http2";', 'const http2 = require("node:http2"); const { Http2ServerRequest, constants } = http2;')
    .replace('import { PassThrough, Readable } from "node:stream";', 'const { PassThrough, Readable } = require("node:stream");');
  const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(control);
  source.context.require = source.runtime.makeRequire("/entry.ts");
  source.context.console = console;
  await source.run(() => runInContext(`(async () => { ${emitted} })()`, source.context));
});

test("@hono/node-server 2.1.1 import links through production builtin export generation", async () => {
  const source = sourceRuntime(scratch);
  const value: unknown = runInContext('require("node:http2")', Object.assign(source.context, { require: source.runtime.makeRequire("/entry.ts") }));
  if (!value || typeof value !== "object") throw new Error("Missing http2 builtin");
  const tools = sourceModuleTools(scratch);
  const key = `http2-${process.pid}`;
  const path = join(scratch, "http2.mjs");
  const consumer = join(scratch, "hono-import.mjs");
  writeFileSync(path, `import.meta.m = { value: globalThis[${JSON.stringify(key)}], default: globalThis[${JSON.stringify(key)}] };\n${tools("wrapper", Object.keys(value))}`);
  writeFileSync(consumer, `import { Http2ServerRequest, constants } from ${JSON.stringify(pathToFileURL(path).href)};\nexport { Http2ServerRequest, constants };`);
  Object.defineProperty(globalThis, key, { value, configurable: true });
  try {
    const imported = await import(pathToFileURL(consumer).href);
    expect(typeof imported.Http2ServerRequest).toBe("function");
    expect(imported.Http2ServerRequest).toBe(Reflect.get(value, "Http2ServerRequest"));
    expect(imported.constants).toBe(Reflect.get(value, "constants"));
  } finally { Reflect.deleteProperty(globalThis, key); }
});
