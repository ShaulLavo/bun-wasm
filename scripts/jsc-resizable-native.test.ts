import { expect, test as bunTest } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeProducerEngines } from "./test-checks.ts";
import { nativeBackingControl } from "./jsc-resizable-native.ts";

const test = nativeProducerEngines().includes("jsc") ? bunTest : bunTest.skip;

test("native resizable backing publishes moved views and rolls failed charges back", () => {
  const root = resolve(import.meta.dir, "..");
  const prebuild = process.env.JSC_BUILD_DIR;
  if (!prebuild) throw new Error("Set JSC_BUILD_DIR to this source's private JSC prebuild");
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-rab-control-"));
  try {
    const output = nativeBackingControl({ root, prebuild, scratch, source: join(root, "tests/native/jsc-resizable-backing.cpp") });
    expect(output.match(/Deterministic native backing controls passed/g)).toHaveLength(3);
    console.log(output);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    expect(existsSync(scratch)).toBe(false);
  }
}, 600000);
