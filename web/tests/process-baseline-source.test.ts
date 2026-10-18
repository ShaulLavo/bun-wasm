import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserBuildConfig } from "../../scripts/browser-build";
import { prepareBaselineSource } from "./process-baseline-source";

const directories = new Set<string>();
afterEach(async () => {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
    directories.delete(directory);
  }
});

async function snapshot() {
  const directory = await mkdtemp(join(process.env.BUN_WASM_TEST_TMP ?? process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-baseline-source-"));
  directories.add(directory);
  await mkdir(join(directory, "runtime"));
  await mkdir(join(directory, "web/src"), { recursive: true });
  return directory;
}

const fixtures = ["process-bench-baseline.ts", "process-benchmark.ts"];
test("baseline setup preserves the selected revision's own measurement harness", async () => {
  const directory = await snapshot();
  await mkdir(join(directory, "web/tests"));
  const sentinel = join(directory, "web/tests/existing-test.ts");
  await writeFile(sentinel, "// Frozen archive test remains unchanged.\n");
  for (const name of fixtures) await writeFile(join(directory, "web/tests", name), `// Frozen ${name}; do not inject the current harness.\n`);

  await prepareBaselineSource(directory);

  expect(await readlink(join(directory, "web/node_modules/@bun-wasm/runtime"))).toBe(join(directory, "runtime"));
  expect(existsSync(join(directory, "web/node_modules/waffle"))).toBe(false);
  for (const name of fixtures) {
    expect(await readFile(join(directory, "web/tests", name), "utf8")).toBe(`// Frozen ${name}; do not inject the current harness.\n`);
  }
  expect(await readFile(sentinel, "utf8")).toBe("// Frozen archive test remains unchanged.\n");
});

test("a pre-extraction baseline bundles its unchanged historical package imports", async () => {
  const directory = await snapshot();
  // Keep this fixture self-contained for source-only runners without Git history.
  // These imports match 74e2cee1's benchmark harness and web/src/fs.ts.
  const harness = 'import { createRuntime } from "@bun-wasm/runtime";\nimport { MemFS } from "../src/fs";\nexport const baseline = [createRuntime(), new MemFS()];\n';
  const filesystem = 'export * from "@bun-wasm/runtime/fs/memory";\n';
  const entrypoint = join(directory, "web/tests/process-bench-baseline.ts");
  await mkdir(join(directory, "web/tests"));
  await mkdir(join(directory, "runtime/fs"));
  await writeFile(join(directory, "runtime/package.json"), JSON.stringify({
    name: "@bun-wasm/runtime", type: "module", exports: {
      ".": { browser: "./index.ts", node: "./dist/index.js" },
      "./fs/memory": { browser: "./fs/memory.ts", node: "./dist/fs/memory.js" },
    },
  }));
  await writeFile(join(directory, "runtime/index.ts"), 'export function createRuntime() { return "archived-runtime"; }\n');
  await writeFile(join(directory, "runtime/fs/memory.ts"), 'export class MemFS { readonly marker = "archived-filesystem"; }\n');
  await writeFile(entrypoint, harness);
  await writeFile(join(directory, "web/tests/process-benchmark.ts"), "// Frozen measurement harness.\n");
  await writeFile(join(directory, "web/src/fs.ts"), filesystem);

  await prepareBaselineSource(directory);
  const result = await Bun.build({ ...browserBuildConfig([entrypoint], join(directory, "dist")), throw: false });

  expect(result.logs.map(String)).toEqual([]);
  expect(result.success).toBe(true);
  const output = await result.outputs.find(output => output.path.endsWith("process-bench-baseline.js"))!.text();
  expect(output).toContain("archived-runtime");
  expect(output).toContain("archived-filesystem");
  expect(await readFile(entrypoint, "utf8")).toBe(harness);
  expect(await readFile(join(directory, "web/src/fs.ts"), "utf8")).toBe(filesystem);
  expect(existsSync(join(directory, "web/node_modules/waffle"))).toBe(false);
});

for (const missing of fixtures) {
  test(`baseline archive without ${missing} is rejected with an archive command`, async () => {
    const directory = await snapshot();
    await mkdir(join(directory, "web/tests"));
    for (const name of fixtures) if (name !== missing) await writeFile(join(directory, "web/tests", name), "// Frozen harness.\n");
    await expect(prepareBaselineSource(directory)).rejects.toThrow(`Baseline archive is missing web/tests/${missing}`);
    await expect(prepareBaselineSource(directory)).rejects.toThrow("git archive REV web/src runtime web/tests/process-bench-baseline.ts web/tests/process-benchmark.ts");
  });
}
