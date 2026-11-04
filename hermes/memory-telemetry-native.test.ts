import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

test("Hermes native cache preserves its exact ABI without linking or building a VM", () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-hermes-telemetry-"));
  try {
    const binary = join(directory, "cache-test");
    execFileSync("c++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-fno-exceptions", "-fno-rtti",
      "-I", join(root, "crates/bunwasm-hermes/cpp"), join(root, "crates/bunwasm-hermes/tests/memory-telemetry.cpp"), "-o", binary]);
    expect(execFileSync(binary, { encoding: "utf8" })).toContain("64 bytes, 1000 allocation-free cached reads; synthetic inputs only");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
