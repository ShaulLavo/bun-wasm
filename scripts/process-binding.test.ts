import assert from "node:assert/strict";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runInContext } from "node:vm";
import { runOwned, sourceRuntime } from "./fixtures/stream-consumers-runtime";
import { selectChecks } from "./test-checks";
import { bindingControls, expectedBinding } from "../tests/fixtures/process-constants-binding/controls";

const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-process-binding-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("Prisma's bundled tmp module can read process binding constants", () => {
  const { context, runtime } = sourceRuntime(scratch);
  context.fixtureRequire = runtime.makeRequire("/entry.ts");
  const result = runInContext(`(() => {
    const constants = process.binding("constants");
    const fs = fixtureRequire("node:fs");
    const os = fixtureRequire("node:os");
    return {
      flags: (constants.O_CREAT || constants.fs.O_CREAT)
        | (constants.O_EXCL || constants.fs.O_EXCL)
        | (constants.O_RDWR || constants.fs.O_RDWR),
      expectedFlags: fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      fsIdentity: constants.fs === fs.constants,
      osIdentity: constants.os === os.constants,
      bindingIdentity: constants === process.binding("constants"),
    };
  })()`, context);
  expect(result.flags).toBe(result.expectedFlags);
  expect(result.flags).toBe(194);
  expect(result.fsIdentity).toBe(true);
  expect(result.osIdentity).toBe(true);
  expect(result.bindingIdentity).toBe(true);
  for (const name of ["crypto", "zlib"]) {
    expect(runInContext(`process.binding("constants").${name} === fixtureRequire("node:${name}").constants`, context)).toBe(true);
  }
  expect(() => runInContext('process.binding("missing")', context)).toThrow("No such module: missing");
});

test("the process binding regression belongs to both runtime gates", () => {
  for (const owner of ["runtime", "local-runtime"]) expect(selectChecks(owner)).toContain("scripts/process-binding.test.ts");
});

function sourceBinding() {
  const source = sourceRuntime(scratch);
  const binding: unknown = runInContext('process.binding("constants")', source.context);
  assert.ok(binding !== null && typeof binding === "object");
  return bindingControls(binding, () => runInContext('process.binding("constants")', source.context));
}

test("constants binding has mutable native data descriptors and cached identity", () => {
  expect(sourceBinding()).toEqual(expectedBinding);
});

for (const engine of ["node", process.execPath]) {
  test(`${engine} descriptors and mutations match the current source binding`, () => {
    const fixture = join(import.meta.dirname, "../tests/fixtures/process-constants-binding/index.ts");
    const result = runOwned(engine, [fixture, "--snapshot"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expectedBinding);
    expect(sourceBinding()).toEqual(JSON.parse(result.stdout));
  });
}

test("process initialization and unknown bindings do not import constants builtins", () => {
  const source = sourceRuntime(scratch);
  const modules = ["node_fs", "crypto_keys", "zlib"];
  for (const name of modules) expect(source.emitted.has(name)).toBe(false);
  expect(() => runInContext('process.binding("missing")', source.context)).toThrow("No such module: missing");
  for (const name of modules) expect(source.emitted.has(name)).toBe(false);
  runInContext('process.binding("constants")', source.context);
  for (const name of modules) expect(source.emitted.has(name)).toBe(true);
  const loaded = source.emitted.size;
  runInContext('process.binding("constants")', source.context);
  expect(source.emitted.size).toBe(loaded);
});
