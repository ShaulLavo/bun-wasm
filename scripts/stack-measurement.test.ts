import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { acceptedStackOutcome, guestStackSettings, stackOutcome, type GuestStackSettings } from "./stack-measurement.ts";

let scratchToClean: string | undefined;
afterAll(() => { if (scratchToClean) rmSync(scratchToClean, { recursive: true, force: true }); });
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-stack-measurement-"));
scratchToClean = scratch;
test("measurement scratch follows the host temporary directory", () => {
  expect(dirname(scratch)).toBe(tmpdir());
});
const root = resolve(import.meta.dir, "..");
const provider = new URL("./fixtures/stack-measurement-provider.ts", import.meta.url).pathname;

function command(kind: "browser" | "python", scenario: string, options: {
  cold?: boolean; output?: string; mode?: string; code?: number; repeat?: boolean; leaf?: boolean; maximum?: number;
  budget?: string; parserReserve?: string; guestSettings?: GuestStackSettings; recordCommands?: boolean; ajvCodegen?: "installed" | "missing";
} = {}) {
  const { cold = false, output, mode = "plain", code = 0, repeat = false, leaf = false, maximum } = options;
  const directory = mkdtempSync(join(scratch, `${kind}-${scenario}-`));
  if (leaf) writeFileSync(join(directory, "leaf.cjs"), "module.exports = 42;\n");
  if (options.ajvCodegen === "installed") writeFileSync(join(directory, "index.js"), "module.exports = {};\n");
  const browser = ["node", "--import", provider, "web/tests/browser-stack.mjs", "--measure"].concat(cold ? ["--cold"] : [], ["chromium"]);
  const shortenTimeout = "import runpy, subprocess; original = subprocess.run; subprocess.run = lambda *a, **kw: original(*a, **dict(kw, timeout=0.2)); runpy.run_path('scripts/measure-stack.py', run_name='__main__')";
  const python = ["python3"].concat(["hang", "hidden-timeout"].includes(scenario) ? ["-c", shortenTimeout] : ["scripts/measure-stack.py"],
    ["--launcher", provider, "--max", String(maximum ?? (output === undefined ? 8 : 1))],
    leaf ? ["--leaf-root", directory, "--leaf", "leaf.cjs"] : [], options.ajvCodegen ? ["--ajv-codegen", directory] : [], [mode], repeat ? [mode] : []);
  const result = Bun.spawnSync(kind === "browser" ? browser : python, {
    cwd: root,
    env: { ...process.env, ENGINES: "jsc", STACK_KIB: options.budget, JSC_PARSER_RESERVE: options.parserReserve,
      STACK_TEST_GUEST_SETTINGS: options.guestSettings === undefined ? undefined : JSON.stringify(options.guestSettings),
      STACK_TEST_RECORD_COMMANDS: options.recordCommands ? "1" : undefined,
      BUN_WASM_SCRATCH_ROOT: directory, STACK_TEST_ROOT: directory, STACK_TEST_SCENARIO: scenario, STACK_TEST_OUTPUT: output, STACK_TEST_STATUS: String(code) },
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
  for (const scenario of ["hidden", "hidden-timeout", "final", "missing", "unexpected", "wrong-depth", "duplicate-continuation"]) {
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

test("Python keeps every attempt's status and stderr, and a trap hidden inside the search fails it", () => {
  const run = command("python", "hidden");
  const row = JSON.parse(run.stdout).results.plain;
  expect(run.result.exitCode).toBe(1);
  expect(row).toMatchObject({ capacity: 2, beyond: "caught:RangeError", failures: [{ depth: 4, outcome: "trap" }] });
  expect(row.attempts).toEqual([
    { depth: 8, outcome: "caught:RangeError", status: 0, timed_out: false, stderr: "" },
    { depth: 4, outcome: "trap", status: 1, timed_out: false, stderr: "fake trap at plain 4\n" },
    { depth: 2, outcome: "completed", status: 0, timed_out: false, stderr: "" },
    { depth: 3, outcome: "caught:RangeError", status: 0, timed_out: false, stderr: "" },
    { depth: 3, outcome: "caught:RangeError", status: 0, timed_out: false, stderr: "" },
  ]);
});

test("Python records a timeout hidden inside the search and fails it", () => {
  const run = command("python", "hidden-timeout");
  const row = JSON.parse(run.stdout).results.plain;
  expect(run.result.exitCode).toBe(1);
  expect(row.failures).toEqual([{ depth: 4, outcome: "timeout" }]);
  expect(row.attempts).toContainEqual({ depth: 4, outcome: "timeout", status: null, timed_out: true, stderr: "" });
  expect(row.attempts.every((attempt: { timed_out: boolean; status: number | null }) => attempt.timed_out === (attempt.status === null))).toBe(true);
});

test("the Ajv mode needs its installed package, and the package option needs the mode", () => {
  const transcript = "completed {mode} {depth}\ncontinued\n";
  expect(command("python", "transcript", { output: transcript, mode: "ajv" }).result.exitCode).toBe(2);
  expect(command("python", "transcript", { output: transcript, mode: "ajv", ajvCodegen: "missing" }).result.exitCode).toBe(2);
  expect(command("python", "transcript", { output: transcript, mode: "plain", ajvCodegen: "installed" }).result.exitCode).toBe(2);
  const run = command("python", "transcript", { output: transcript, mode: "ajv", ajvCodegen: "installed" });
  expect(run.result.exitCode).toBe(0);
  expect(JSON.parse(run.stdout).results.ajv).toMatchObject({ completed_at_max: 1 });
});

for (const mode of ["computedgetter", "ajvnames"]) {
  test(`both sweeps accept the ${mode} path`, () => {
    const output = `caught ${mode} RangeError 1 stack overflow\ncontinued\n`;
    expect(stackOutcome({ code: 0, output }, mode, 1)).toBe("caught:RangeError");
    expect(command("python", "transcript", { output: "caught {mode} RangeError {depth} stack overflow\ncontinued\n", mode }).result.exitCode).toBe(0);
  });
}

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
  { label: "duplicate continuation", output: "completed {mode} {depth}\ncontinued\ncontinued\n", mode: "plain", expected: "invalid-output" },
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


function requireAttempts(directory: string) {
  const entries: unknown[] = readFileSync(join(directory, "require-attempts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  return entries.map(entry => {
    if (!entry || typeof entry !== "object" || !("scratch" in entry) || typeof entry.scratch !== "string") throw new Error("Missing require scratch path");
    return { entry, scratch: entry.scratch };
  });
}

function expectRequireCleanup(directory: string) {
  const attempts = requireAttempts(directory);
  expect(attempts.length).toBeGreaterThan(0);
  expect(new Set(attempts.map(attempt => attempt.scratch)).size).toBe(1);
  for (const attempt of attempts) {
    expect(attempt.entry).toMatchObject({ scratchAlive: true, scratchValue: "/stack-depth-scratch" });
    expect(existsSync(attempt.scratch)).toBe(false);
  }
  expect(readdirSync(directory).filter(name => name.startsWith("bun-wasm-stack-require-"))).toEqual([]);
  return attempts;
}

const refusedBaselines = [
  { label: "caught overflow", output: "caught require RangeError 0 stack overflow\ncontinued\n", outcome: "caught:RangeError" },
  { label: "caught syntax error", output: "caught require SyntaxError 0 bad syntax\ncontinued\n", outcome: "unexpected:SyntaxError" },
  { label: "unexpected class", output: "caught require TypeError 0 failed\ncontinued\n", outcome: "unexpected:TypeError" },
  { label: "wrong depth", output: "completed require 1\ncontinued\n", outcome: "invalid-output" },
  { label: "missing continuation", output: "completed require 0\n", outcome: "missing-continuation" },
  { label: "duplicate continuation", output: "completed require 0\ncontinued\ncontinued\n", outcome: "invalid-output" },
  { label: "trap with markers", output: "completed require 0\ncontinued\n", code: 1, outcome: "trap" },
];
for (const entry of refusedBaselines) {
  test(`require refuses zero-depth ${entry.label} and fails after cleanup`, () => {
    const run = command("python", "transcript", { mode: "require", output: entry.output, code: entry.code, leaf: true });
    const report = JSON.parse(run.stdout);
    expect(report).toMatchObject({ leaf: "leaf.cjs", results: { require: {
      refused_at_zero: entry.outcome, failures: [{ depth: 0, outcome: entry.outcome }],
    } } });
    expect(report.results.require).not.toHaveProperty("capacity");
    expect(expectRequireCleanup(run.directory)).toHaveLength(1);
    expect(run.result.exitCode).toBe(1);
  });
}

test("require zero-depth timeout is recorded and its launcher and scratch are gone", () => {
  const run = command("python", "hang", { mode: "require", leaf: true });
  expect(JSON.parse(run.stdout).results.require).toEqual({
    refused_at_zero: "timeout", failures: [{ depth: 0, outcome: "timeout" }],
    attempts: [{ depth: 0, outcome: "timeout", status: null, timed_out: true, stderr: "" }],
  });
  expect(expectRequireCleanup(run.directory)).toHaveLength(1);
  const pid = Number(readFileSync(join(run.directory, "launcher.pid"), "utf8").trim());
  expect(() => process.kill(pid, 0)).toThrow("No such process");
  expect(run.result.exitCode).toBe(1);
});

test("require shares a live private leaf preopen across zero-depth and the capped maximum", () => {
  const run = command("python", "transcript", { mode: "require", output: "completed {mode} {depth}\ncontinued\n", leaf: true, maximum: 1024, repeat: true });
  expect(run.result.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ leaf: "leaf.cjs", results: { require: { completed_at_max: 512, failures: [] } } });
  const attempts = expectRequireCleanup(run.directory);
  expect(attempts.map(attempt => attempt.entry)).toEqual([0, 512].map(depth => expect.objectContaining({
    depth, leafValue: "/stack-depth-leaf/leaf.cjs", leafSource: "module.exports = 42;\n",
  })));
});

test("require retains an intermediate failure even when the final boundary is caught safely", () => {
  const run = command("python", "hidden", { mode: "require" });
  expect(run.result.exitCode).toBe(1);
  expect(JSON.parse(run.stdout)).toMatchObject({ leaf: null, results: { require: {
    capacity: 2, beyond: "caught:RangeError", failures: [{ depth: 4, outcome: "trap" }],
  } } });
  expectRequireCleanup(run.directory);
});

for (const entry of [
  { args: ["--max", "0", "require"], message: "--max must be positive" },
  { args: ["missing-mode"], message: "unknown stack mode" },
  { args: ["--leaf", "leaf.cjs", "require"], message: "--leaf and --leaf-root go together" },
  { args: ["--leaf-root", scratch, "require"], message: "--leaf and --leaf-root go together" },
  { args: ["--leaf-root", scratch, "--leaf", "leaf.cjs", "plain"], message: "--leaf applies to the require mode" },
]) {
  test(`Python CLI rejects ${entry.message} before launching`, () => {
    const run = Bun.spawnSync(["python3", "scripts/measure-stack.py"].concat(entry.args), { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(2);
    expect(run.stdout.toString()).toBe("");
    expect(run.stderr.toString()).toContain(entry.message);
  });
}


function browserCommands(directory: string): string[] {
  return readFileSync(join(directory, "browser-commands.jsonl"), "utf8").trim().split("\n").map(line => {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "string") throw new Error("Invalid recorded browser command");
    return parsed;
  });
}

function actualCommandSettings(command: string): GuestStackSettings {
  const end = command.indexOf("bun run ");
  expect(end).toBeGreaterThanOrEqual(0);
  const read = 'console.log(JSON.stringify({budget:process.env.BUN_WASM_STACK_KIB??null,parserReserve:process.env.BUN_WASM_JSC_PARSER_RESERVE??null}))';
  const result = Bun.spawnSync(["sh", "-c", `${command.slice(0, end)}"$STACK_TEST_BUN" -e '${read}'`], {
    env: { ...process.env, STACK_TEST_BUN: process.execPath, BUN_WASM_STACK_KIB: undefined, BUN_WASM_JSC_PARSER_RESERVE: undefined },
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  const settings = guestStackSettings(`settings ${result.stdout.toString().trim()}`);
  if (!settings) throw new Error("No shell environment result");
  return settings;
}

for (const parserReserve of ["1024 ", " 1024", "", "1024'quoted"]) {
  test(`browser entry preserves the literal parser override ${JSON.stringify(parserReserve)}`, () => {
    const settings = { budget: "192", parserReserve };
    const run = command("browser", "safe", { budget: "192", parserReserve, guestSettings: settings, recordCommands: true });
    expect(run.result.exitCode).toBe(0);
    const commands = browserCommands(run.directory);
    expect(actualCommandSettings(commands[0]!)).toEqual(settings);
    const summary: unknown = JSON.parse(run.stdout.split("\n").find(line => line.includes('"settings":'))!);
    expect(summary).toMatchObject({ settings: { guests: [settings] } });
  });
}

test("browser margin probes and both original fixtures receive the same tuple", () => {
  const settings = { budget: "260", parserReserve: "960" };
  const run = command("browser", "safe", { cold: true, budget: "260", parserReserve: "960", guestSettings: settings, recordCommands: true });
  expect(run.result.exitCode).toBe(0);
  const commands = browserCommands(run.directory);
  const fixtures = commands.filter(value => /bun run stack-overflow(?:-console)?\.js$/.test(value));
  expect(fixtures).toHaveLength(2);
  for (const value of [commands[0]!].concat(fixtures)) expect(actualCommandSettings(value)).toEqual(settings);
  const contexts = readFileSync(join(run.directory, "cleanup.log"), "utf8").split("\n").filter(value => value === "context");
  expect(contexts).toHaveLength(commands.length + 1);
});

for (const guestSettings of [undefined, { budget: "208", parserReserve: "960" }, { budget: "260", parserReserve: "1024" }]) {
  test(`browser entry rejects mismatched or missing requested settings ${JSON.stringify(guestSettings)}`, () => {
    const run = command("browser", "safe", { budget: "260", parserReserve: "960", guestSettings });
    expect(run.result.exitCode).not.toBe(0);
    expect(run.stdout).toContain("settings-mismatch");
    expect(readFileSync(join(run.directory, "cleanup.log"), "utf8")).toContain("session\n");
  });
}
