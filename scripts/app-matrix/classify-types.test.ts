import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-classify-types-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const probe = join(scratch, "probe.ts");
const config = join(scratch, "tsconfig.json");
writeFileSync(config, JSON.stringify({ extends: join(root, "tsconfig.scripts.json"), compilerOptions: { typeRoots: [join(root, "node_modules/@types")] }, include: [], files: [probe] }));
const classifier = fileURLToPath(new URL("./classify.ts", import.meta.url));

function check(source: string) {
  writeFileSync(probe, `import { compareEngines, failure, firstError, stageOutput } from ${JSON.stringify(classifier)};\n${source}`);
  return Bun.spawnSync([join(root, "node_modules/.bin/tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
}

test("accepts readonly rows and retains extra fields and narrow classification outputs", () => {
  const result = check(`
    const row = Object.freeze({ app: "prettier", host: "native", stage: "check", engine: "quickjs", status: "fail", category: "c", passesOn: Object.freeze(["browser"] satisfies ("quickjs" | "jsc" | "browser")[]), marker: 7 });
    const results = compareEngines(Object.freeze([row]));
    for (const result of results) {
      const marker: number = result.marker;
      const category: "a" | "b" | "c" | "d" | "e" | "f" | undefined = result.category;
      const engines: readonly ("quickjs" | "jsc" | "browser")[] | undefined = result.passesOn;
      void [marker, category, engines];
    }
    const category: "a" | "b" | "c" | "d" = failure("Error: missing", "build").category;
    const diagnostic: string = firstError("Error: missing");
    const output: string = stageOutput("user@bun:~$ bun run\\nbody", "bun run");
    void [category, diagnostic, output];
  `);
  expect(result.stdout.toString() + result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

const invalid = [
  ["unknown engine", 'compareEngines([{ app: "a", host: "native", stage: "build", engine: "v8", status: "fail" }]);'],
  ["unknown status", 'compareEngines([{ app: "a", host: "native", stage: "build", engine: "quickjs", status: "failed" }]);'],
  ["unknown category", 'compareEngines([{ app: "a", host: "native", stage: "build", engine: "quickjs", status: "fail", category: "z" }]);'],
  ["unknown passing engine", 'compareEngines([{ app: "a", host: "native", stage: "build", engine: "quickjs", status: "fail", passesOn: ["v8"] }]);'],
  ["non-string output", 'firstError(7);'],
  ["non-string command", 'stageOutput("log", 7);'],
  ["non-string stage", 'failure("Error: missing", 7);'],
] satisfies readonly (readonly [string, string])[];
for (const [label, source] of invalid) {
  test(`rejects ${label}`, () => {
    const result = check(source);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}
