import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "bun-wasm-next-webpack-resolve-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const factory = join(directory, "module_compile.js");
const prepareFactory = join(directory, "source_prepare.js");
beforeAll(() => {
  for (const [name, destination] of [["module_compile", factory], ["source_prepare", prepareFactory]] satisfies [string, string][]) {
    const result = Bun.spawnSync(["node", "--disable-warning=ExperimentalWarning", new URL("./transpile-runtime.ts", import.meta.url).pathname,
      new URL(`../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url).pathname, destination], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  }
});

for (const mode of ["native", "runtime", "runtime-host"]) {
  for (const contract of ["next", "hooks"]) {
    test(`node ${mode} resolves ${contract} through the mutable Module hook`, () => {
      const result = Bun.spawnSync(["node", "--disable-warning=ExperimentalWarning", new URL("./next-webpack-resolve-probe.ts", import.meta.url).pathname, mode, directory, contract], {
        stdout: "pipe", stderr: "pipe", env: { ...process.env, BUNWASM_MODULE_COMPILE_FACTORY: factory, BUNWASM_SOURCE_PREPARE_FACTORY: prepareFactory },
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('"status":"pass"');
    });
  }
}

test("Next 16.4.3 require hook is frozen without edits", () => {
  const source = readFileSync(new URL("./fixtures/next-webpack-resolve-hook/require-hook.txt", import.meta.url));
  expect(createHash("sha256").update(source).digest("hex")).toBe("e82f0ceba88d025c725ea3062974ad9d7a54a892df8c34a525cb129202387db8");
});
