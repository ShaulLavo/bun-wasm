import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

let scratch: string | undefined;
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });
scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-stack-measurement-"));
const root = resolve(import.meta.dir, "..");
const provider = join(root, "scripts/fixtures/stack-measurement-provider.ts");

function command(kind: "browser" | "python", scenario: string, cold = false) {
  const directory = mkdtempSync(join(scratch!, `${kind}-${scenario}-`));
  const browser = ["node", "--import", provider, "web/tests/browser-stack.mjs", "--measure"].concat(cold ? ["--cold"] : [], ["chromium"]);
  const python = ["python3", "scripts/measure-stack.py", "--launcher", provider, "--max", "8", "plain"];
  const result = Bun.spawnSync(kind === "browser" ? browser : python, {
    cwd: root,
    env: { ...process.env, ENGINES: "jsc", STACK_TEST_ROOT: directory, STACK_TEST_SCENARIO: scenario },
    stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  return { result, directory, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

for (const kind of ["browser", "python"] as const) {
  test(`${kind} accepts completion and an expected caught overflow`, () => {
    const run = command(kind, "safe");
    expect(run.result.exitCode).toBe(0);
    expect(run.stdout).toContain("capacity");
    expect(run.stdout).toContain("caught:RangeError");
  });
  for (const scenario of ["hidden", "final", "missing", "unexpected", "wrong-depth"]) {
    test(`${kind} rejects ${scenario} after cleanup`, () => {
      const run = command(kind, scenario, true);
      if (kind === "browser") {
        expect(readdirSync(run.directory)).toEqual(["cleanup.log"]);
        expect(readFileSync(join(run.directory, "cleanup.log"), "utf8")).toContain("session\n");
      }
      expect(run.result.exitCode).not.toBe(0);
      expect(run.stdout).toContain("failures");
      if (scenario === "hidden") expect(run.stdout).toContain(kind === "browser" ? '"depth":100000' : '"depth": 4');
    });
  }
}

for (const scenario of ["timeout", "throw"]) {
  test(`browser rejects provider ${scenario} and closes cold resources`, () => {
    const run = command("browser", scenario, true);
    expect(run.result.exitCode).not.toBe(0);
    expect(readdirSync(run.directory)).toEqual(["cleanup.log"]);
  });
}
