import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixtureCases, loaderSource } from "./esm-loader-harness";
import { runCase } from "./esm-loader-run";

const loader = loaderSource();
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "bun-wasm-esm-loader-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

for (const name of fixtureCases()) {
  test(`esm loader: ${name} matches Node`, () => {
    const result = runCase(name, [process.execPath], scratch, loader);
    expect(result.actual).toBe(result.expected);
  });
}
