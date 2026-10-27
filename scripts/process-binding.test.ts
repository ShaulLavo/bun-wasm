import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runInContext } from "node:vm";
import { sourceRuntime } from "./fixtures/stream-consumers-runtime";
import { selectChecks } from "./test-checks";

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
