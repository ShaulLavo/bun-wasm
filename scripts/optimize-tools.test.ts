import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optimizeTools } from "./optimize-tools";
import { needsJsc, needsRust } from "./ci-changes";

async function fixture(run: (options: Parameters<typeof optimizeTools>[0], calls: () => number) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-tools-optimizer-"));
  const optimizer = join(root, "wasm-opt");
  const raw = join(root, "raw.wasm");
  const count = join(root, "calls");
  const cache = join(root, "cache");
  writeFileSync(raw, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  writeFileSync(count, "");
  writeFileSync(optimizer, `#!${process.execPath}\nimport { appendFileSync, copyFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nconst index = args.indexOf("-o");\nappendFileSync(${JSON.stringify(count)}, "call\\n");\ncopyFileSync(args[index - 1], args[index + 1]);\n`, { mode: 0o755 });
  try {
    await run({ raw, output: join(root, "output.wasm"), cache, optimizer, flags: ["-O2", "-g"] }, () => readFileSync(count, "utf8").split("\n").length - 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("unchanged raw bytes, optimizer and flags reuse the validated tools output", async () => {
  await fixture(async (options, calls) => {
    await optimizeTools(options);
    expect(calls()).toBe(1);
    rmSync(options.output);
    await optimizeTools(options);
    expect(calls()).toBe(1);
    expect(readFileSync(options.output)).toEqual(readFileSync(options.raw));
    expect(readdirSync(options.cache).sort()).toEqual(["bun-tools.wasm", "receipt.json"]);
  });
});

for (const changed of ["raw", "optimizer", "flags", "corrupt-output", "missing-output", "corrupt-receipt", "missing-receipt"] as const) test(`tools optimization rebuilds after ${changed}`, async () => {
  await fixture(async (options, calls) => {
    await optimizeTools(options);
    if (changed === "raw") writeFileSync(options.raw, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 2, 1, 120]));
    if (changed === "optimizer") writeFileSync(options.optimizer, readFileSync(options.optimizer, "utf8") + "\n// New optimizer binary.\n");
    if (changed === "flags") options.flags = options.flags.concat(["--enable-threads"]);
    if (changed === "corrupt-output") writeFileSync(join(options.cache, "bun-tools.wasm"), "corrupt");
    if (changed === "missing-output") rmSync(join(options.cache, "bun-tools.wasm"));
    if (changed === "corrupt-receipt") writeFileSync(join(options.cache, "receipt.json"), "{");
    if (changed === "missing-receipt") rmSync(join(options.cache, "receipt.json"));
    await optimizeTools(options);
    expect(calls()).toBe(2);
    expect(readFileSync(options.output)).toEqual(readFileSync(options.raw));
    await optimizeTools(options);
    expect(calls()).toBe(2);
  });
});

test("a failed optimizer leaves no reusable output and removes its scratch directory", async () => {
  await fixture(async (options, calls) => {
    writeFileSync(options.optimizer, `#!${process.execPath}\nprocess.exit(42);\n`);
    await expect(optimizeTools(options)).rejects.toThrow();
    expect(calls()).toBe(0);
    expect(readdirSync(options.cache)).toEqual([]);
  });
});

test("tools still capture current inputs and write a new build receipt after optimizer reuse", () => {
  const source = readFileSync(new URL("./build-bun-tools.sh", import.meta.url), "utf8");
  expect(source.indexOf('inputs tools > "$guest_inputs"')).toBeLessThan(source.indexOf('scripts/optimize-tools.ts'));
  expect(source.indexOf('scripts/optimize-tools.ts')).toBeLessThan(source.indexOf('write "$root/dist/bun-tools.wasm" "$guest_inputs"'));
  expect(needsRust(["scripts/optimize-tools.ts"])).toBe(true);
  expect(needsJsc(["scripts/optimize-tools.ts"])).toBe(true);
});
