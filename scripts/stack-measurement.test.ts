import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { acceptedStackOutcome, stackOutcome } from "./stack-measurement.ts";

let scratchToClean: string | undefined;
afterAll(() => { if (scratchToClean) rmSync(scratchToClean, { recursive: true, force: true }); });
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-stack-measurement-"));
scratchToClean = scratch;
const root = resolve(import.meta.dir, "..");
const provider = new URL("./fixtures/stack-measurement-provider.ts", import.meta.url).pathname;

function command(kind: "browser" | "python", scenario: string, options: {
  cold?: boolean; output?: string; mode?: string; code?: number; repeat?: boolean;
} = {}) {
  const { cold = false, output, mode = "plain", code = 0, repeat = false } = options;
  const directory = mkdtempSync(join(scratch, `${kind}-${scenario}-`));
  const browser = ["node", "--import", provider, "web/tests/browser-stack.mjs", "--measure"].concat(cold ? ["--cold"] : [], ["chromium"]);
  const shortenTimeout = "import runpy, subprocess; original = subprocess.run; subprocess.run = lambda *a, **kw: original(*a, **dict(kw, timeout=0.2)); runpy.run_path('scripts/measure-stack.py', run_name='__main__')";
  const python = ["python3"].concat(["hang", "hidden-timeout"].includes(scenario) ? ["-c", shortenTimeout] : ["scripts/measure-stack.py"],
    ["--launcher", provider, "--max", output === undefined ? "8" : "1", mode], repeat ? [mode] : []);
  const result = Bun.spawnSync(kind === "browser" ? browser : python, {
    cwd: root,
    env: { ...process.env, ENGINES: "jsc", STACK_TEST_ROOT: directory, STACK_TEST_SCENARIO: scenario, STACK_TEST_OUTPUT: output, STACK_TEST_STATUS: String(code) },
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
  for (const scenario of ["hidden", "hidden-timeout", "final", "missing", "unexpected", "wrong-depth"]) {
    test(`${kind} rejects ${scenario} after cleanup`, () => {
      const run = command(kind, scenario, { cold: true });
      if (kind === "browser") {
        expect(readdirSync(run.directory)).toEqual(["cleanup.log"]);
        expect(readFileSync(join(run.directory, "cleanup.log"), "utf8")).toContain("session\n");
      }
      expect(run.result.exitCode).not.toBe(0);
      expect(run.stdout).toContain("failures");
      if (scenario !== "hidden") return;
      expect(run.stdout).toContain(kind === "browser" ? '"depth":100000' : '"depth": 4');
      const row = kind === "browser" ? JSON.parse(run.stdout.split("\n")[0]!) : JSON.parse(run.stdout).results.plain;
      expect(row).toMatchObject({ capacity: 2, beyond: "caught:RangeError" });
    });
  }
}

for (const scenario of ["timeout", "throw"]) {
  test(`browser rejects provider ${scenario} and closes cold resources`, () => {
    const run = command("browser", scenario, { cold: true });
    expect(run.result.exitCode).not.toBe(0);
    expect(readdirSync(run.directory)).toEqual(["cleanup.log"]);
  });
}


test("Python timeout kills and reaps every attempted launcher before returning failure", () => {
  const run = command("python", "hang");
  expect(run.result.exitCode).toBe(1);
  expect(run.stdout).toContain('"outcome": "timeout"');
  const pids = readFileSync(join(run.directory, "launcher.pid"), "utf8").trim().split("\n");
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) expect(() => process.kill(Number(pid), 0)).toThrow("No such process");
});

const transcripts = [
  { label: "completion", output: "completed {mode} {depth}\ncontinued\n", mode: "plain", expected: "completed" },
  { label: "overflow", output: "caught {mode} RangeError {depth} stack overflow\ncontinued\n", mode: "getter", expected: "caught:RangeError" },
  { label: "parser overflow", output: "caught {mode} SyntaxError {depth} stack overflow\ncontinued\n", mode: "parse", expected: "caught:SyntaxError" },
  { label: "regexp limit", output: "caught {mode} SyntaxError {depth} regular expression too large\ncontinued\n", mode: "regexpnc", expected: "caught:SyntaxError" },
  { label: "unexpected syntax error", output: "caught {mode} SyntaxError {depth} bad syntax\ncontinued\n", mode: "plain", expected: "unexpected:SyntaxError" },
  { label: "unexpected console overflow", output: "caught {mode} RangeError {depth} stack overflow\ncontinued\n", mode: "console", expected: "unexpected:RangeError" },
  { label: "unexpected error", output: "caught {mode} Error {depth} failure\ncontinued\n", mode: "getter", expected: "unexpected:Error" },
  { label: "partial continuation", output: "completed {mode} {depth}\nnot-continued\n", mode: "plain", expected: "missing-continuation" },
  { label: "early continuation", output: "continued\ncompleted {mode} {depth}\n", mode: "plain", expected: "missing-continuation" },
  { label: "duplicate results", output: "completed {mode} {depth}\ncaught {mode} TypeError {depth} bad\ncontinued\n", mode: "plain", expected: "invalid-output" },
  { label: "wrong mode", output: "completed other {depth}\ncontinued\n", mode: "plain", expected: "invalid-output" },
  { label: "missing result", output: "continued\n", mode: "plain", expected: "invalid-output" },
  { label: "trap despite markers", output: "completed {mode} {depth}\ncontinued\n", mode: "plain", code: 1, expected: "trap" },
];
for (const entry of transcripts) {
  test(`both classifiers enforce ${entry.label}`, () => {
    const output = entry.output.replaceAll("{mode}", entry.mode).replaceAll("{depth}", "1");
    expect(stackOutcome({ code: entry.code ?? 0, output }, entry.mode, 1)).toBe(entry.expected);
    const run = command("python", "transcript", { output: entry.output, mode: entry.mode, code: entry.code });
    const row = JSON.parse(run.stdout).results[entry.mode];
    expect(run.result.exitCode).toBe(acceptedStackOutcome(entry.mode, entry.expected) ? 0 : 1);
    expect(row.beyond ?? "completed").toBe(entry.expected);
  });
}

test("only browser-native Firefox's recursion error is an allowed InternalError", () => {
  const result = { code: 0, output: "caught plain InternalError 1 too much recursion\ncontinued\n" };
  expect(stackOutcome(result, "plain", 1, true)).toBe("caught:InternalError");
  expect(stackOutcome(result, "plain", 1)).toBe("unexpected:InternalError");
  expect(stackOutcome({ code: 0, output: result.output.replace("too much recursion", "other failure") }, "plain", 1, true)).toBe("unexpected:InternalError");
});


test("repeated Python mode arguments cannot overwrite an earlier measurement", () => {
  const run = command("python", "transcript", { output: "completed {mode} {depth}\ncontinued\n", repeat: true });
  expect(run.result.exitCode).toBe(0);
  expect(readFileSync(join(run.directory, "launcher.pid"), "utf8").trim().split("\n")).toHaveLength(1);
});
