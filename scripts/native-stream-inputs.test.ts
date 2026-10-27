import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-stream-inputs-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("browser interop inputs include executable typed streams without loading Playwright", () => {
  const dump = join(scratch, "inputs.json");
  const result = Bun.spawnSync(["node", join(import.meta.dir, "test-native-stream-interop.mjs"), "--dump", dump], {
    env: { ...process.env, PLAYWRIGHT: join(scratch, "missing-playwright.mjs") },
  });
  expect(result.exitCode).toBe(0);
  const sources: unknown = JSON.parse(readFileSync(dump, "utf8"));
  if (!sources || typeof sources !== "object") throw new Error("Expected interop input object");
  for (const name of ["buffer", "events", "streams", "node_stream_core", "node_stream_web", "node_stream_bindings", "compression_streams"]) {
    expect(sources).toHaveProperty(name);
  }
  if (!("streams" in sources) || typeof sources.streams !== "string") throw new Error("Missing streams source");
  expect(sources.streams).toContain('"use strict";');
  expect(runInNewContext(`typeof ${sources.streams}`)).toBe("function");
});

test("package archive carries the native stream bridge and its direct helper", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-direct-pack-"));
  try {
    const archive = join(scratch, "package.tgz");
    const packed = Bun.spawnSync(["bun", "pm", "pack", "--ignore-scripts", "--filename", archive], { cwd: join(import.meta.dir, "..") });
    expect(packed.exitCode).toBe(0);
    const listed = Bun.spawnSync(["tar", "-tzf", archive]);
    expect(listed.exitCode).toBe(0);
    const files = listed.stdout.toString().split("\n");
    expect(files).toContain("package/web/src/native-stream-state.ts");
    expect(files).toContain("package/web/src/native-direct-stream.ts");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
