import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const finalizerTest = "deferred native destruction permits destructor reentry into the registry";
const commonjsTest = "the real CommonJS wrapper keeps its exact body and other negative shapes reject";
const inputs = [
  "scripts/spidermonkey-semantics.test.ts",
  "scripts/spidermonkey-native-controls.ts",
  "crates/bunwasm-spidermonkey/cpp/engine.cpp",
  "crates/bunwasm-engine-spidermonkey/src/vm.rs",
  "crates/bunwasm-runtime/src/modules.rs",
];

function compilerWrapper(directory: string, name: string, prelude: string): void {
  const compiler = Bun.which(name);
  if (!compiler) throw new Error(`Missing ${name}`);
  const quoted = `'${compiler.replaceAll("'", "'\\''")}'`;
  const trace = (stage: string) => `printf '%s %s %s\\n' "$(date +%s)" '${name}' '${stage}' >> "$BUN_WASM_SM_COMPILER_TRACE"`;
  writeFileSync(join(directory, name), `#!/bin/sh\n${trace("entered")}\n${prelude}\n${trace("exec")}\nexec ${quoted} "$@"\n`, { mode: 0o755 });
}

function processOutcome(result: Pick<Bun.SyncSubprocess, "exitCode" | "signalCode" | "exitedDueToTimeout" | "exitedDueToMaxBuffer">) {
  return {
    exitCode: result.exitCode,
    signalCode: result.signalCode ?? null,
    timedOut: result.exitedDueToTimeout === true,
    maxBufferExceeded: result.exitedDueToMaxBuffer === true,
  };
}

function readObservation(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch { return null; }
}

function parseStat(text: string) {
  const start = text.indexOf(" (");
  const end = text.lastIndexOf(")");
  if (start < 1 || end <= start || text[end + 1] !== " ") return null;
  const fields = text.slice(end + 2).trim().split(/\s+/);
  const numeric = [text.slice(0, start), fields[1], fields[2], fields[3], fields[9], fields[11], fields[12], fields[19]];
  if (numeric.some(value => value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) return null;
  if (!fields[0] || !/^[A-Za-z]$/.test(fields[0])) return null;
  return {
    pid: Number(numeric[0]), parent: Number(numeric[1]), group: Number(numeric[2]), session: Number(numeric[3]),
    name: text.slice(start + 2, end), state: fields[0], majorFaults: Number(numeric[4]),
    userTicks: Number(numeric[5]), systemTicks: Number(numeric[6]), startTicks: Number(numeric[7]),
  };
}

function processObservation(pid: string, group: number) {
  const text = readObservation(`/proc/${pid}/stat`);
  const stat = text === null ? null : parseStat(text);
  if (!stat || stat.pid !== Number(pid) || stat.group !== group) return null;
  const io = readObservation(`/proc/${pid}/io`);
  const bytes = io?.match(/^read_bytes: (\d+)$/m)?.[1];
  const readBytes = bytes !== undefined && Number.isSafeInteger(Number(bytes)) ? Number(bytes) : null;
  return { ...stat, readBytes };
}

function scanOwnedGroup(group: number | undefined) {
  if (process.platform !== "linux" || group === undefined || !Number.isSafeInteger(group) || group <= 0) return null;
  try {
    return readdirSync("/proc").filter(pid => /^\d+$/.test(pid))
      .map(pid => processObservation(pid, group)).filter(entry => entry !== null);
  } catch { return null; }
}

function scratchNames(root: string): string[] | null {
  try { return readdirSync(root, { recursive: true, encoding: "utf8" }).sort(); }
  catch { return null; }
}

function hostPressure(kind: string): string | null {
  const text = readObservation(`/proc/pressure/${kind}`);
  const first = text?.split("\n")[0];
  return first && /^some avg10=\d+(?:\.\d+)? avg60=\d+(?:\.\d+)? avg300=\d+(?:\.\d+)? total=\d+$/.test(first) ? first : null;
}

function deadlineObservation(pid: number | undefined, temporary: string) {
  const scanStartedAt = Date.now();
  const processes = scanOwnedGroup(pid);
  const files = scratchNames(temporary);
  const hostWidePressure = { io: hostPressure("io"), cpu: hostPressure("cpu"), memory: hostPressure("memory") };
  return { group: pid ?? null, boundary: "post-child-return/pre-group-kill", scanStartedAt, scanEndedAt: Date.now(), processes, files, hostWidePressure };
}

function runControls(root: string, args: readonly string[] = [], env = process.env) {
  const trace = join(root, "compiler.trace");
  const temporary = mkdtempSync(join(root, "tmp/control-"));
  writeFileSync(trace, "");
  writeFileSync(`${trace}.progress`, "");
  const started = performance.now();
  let pid: number | undefined;
  try {
    const result = Bun.spawnSync([process.execPath, "test", "./scripts/spidermonkey-semantics.test.ts"].concat(args), {
      cwd: root,
      detached: true,
      // Bun's agent output hides the passing test names used here to prove execution.
      env: { ...env, CLAUDECODE: undefined, TMPDIR: temporary, PATH: `${join(root, "bin")}:${env.PATH}`, BUN_WASM_SM_COMPILER_TRACE: trace },
      timeout: 30_000,
    });
    pid = result.pid;
    return {
      ...processOutcome(result),
      elapsedMs: performance.now() - started,
      output: result.stdout.toString() + result.stderr.toString(),
      leftovers: readdirSync(temporary),
      compilerTrace: readFileSync(trace, "utf8"),
      compilerProgress: readObservation(`${trace}.progress`),
      deadline: deadlineObservation(pid, temporary),
      compilerCommands: { cxx: readFileSync(join(root, "bin/c++"), "utf8"), rustup: readFileSync(join(root, "bin/rustup"), "utf8") },
    };
  } finally {
    try { stopCompilerGroup(pid); }
    finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}

function stopCompilerGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

function expectCompleted(result: ReturnType<typeof runControls>, exitCode: number): void {
  expect(result, JSON.stringify(result, null, 2)).toMatchObject({ exitCode, signalCode: null, timedOut: false, maxBufferExceeded: false });
}

function expectRuntimeControls(result: ReturnType<typeof runControls>): void {
  expectCompleted(result, 0);
  expect(result.output).toContain(`(pass) ${commonjsTest}`);
  expect(result.output).toContain(`(pass) ${finalizerTest}`);
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    return false;
  }
}

// These child suites compile real extracted controls, so prepare them outside test timers too.
function prepareRegressionControls() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-sm-setup-"));
  try {
    for (const path of inputs) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(resolve(import.meta.dir, "..", path)));
    }
    mkdirSync(join(root, "tmp"));
    mkdirSync(join(root, "bin"));
    compilerWrapper(join(root, "bin"), "c++", "sleep 6");
    compilerWrapper(join(root, "bin"), "rustup", "sleep 6");
    const started = performance.now();
    const slow = runControls(root, [], { ...process.env, CLAUDECODE: "1" });
    const compileElapsedMs = performance.now() - started;

    compilerWrapper(join(root, "bin"), "c++", "");
    compilerWrapper(join(root, "bin"), "rustup", "");
    const adapterPath = join(root, "crates/bunwasm-engine-spidermonkey/src/vm.rs");
    const adapter = readFileSync(adapterPath, "utf8");
    writeFileSync(adapterPath, adapter.replace(/fn drop_dead_natives\(\) \{[\s\S]*?\n\}/, `fn drop_dead_natives() {
    let dead = DEAD.with(|dead| dead.borrow_mut().drain(..).collect::<Vec<_>>());
    NATIVES.with(|natives| {
        let mut natives = natives.borrow_mut();
        for id in dead { drop(natives.remove(&id)); }
    });
}`));
    const wrongBorrow = runControls(root);

    writeFileSync(adapterPath, adapter);
    const filtered = runControls(root, ["--test-name-pattern", "no-matching-test-name", "--pass-with-no-tests"]);

    compilerWrapper(join(root, "bin"), "c++", "sleep 1");
    compilerWrapper(join(root, "bin"), "rustup", "exit 7");
    const failedBuild = runControls(root);
    compilerWrapper(join(root, "bin"), "c++", 'printf "%s\\n" "$$" > "$BUN_WASM_SM_COMPILER_TRACE.pid"\nkill -KILL "$PPID"\nexec sleep 30');
    compilerWrapper(join(root, "bin"), "rustup", "");
    const interrupted = runControls(root);
    const interruptedCompilerPid = Number(readFileSync(join(root, "compiler.trace.pid"), "utf8"));
    const interruptedTemporaryEntries = readdirSync(join(root, "tmp"));
    compilerWrapper(join(root, "bin"), "c++", "");
    const afterInterruption = runControls(root);
    const interruptedCompilerAlive = processExists(Number(readFileSync(join(root, "compiler.trace.pid"), "utf8")));
    compilerWrapper(join(root, "bin"), "c++", 'rm -f "$BUN_WASM_SM_COMPILER_TRACE.progress"\nmkdir "$BUN_WASM_SM_COMPILER_TRACE.progress"');
    const unavailableProgress = runControls(root);
    return { unavailableProgress, slow, compileElapsedMs, wrongBorrow, filtered, failedBuild, interrupted, interruptedTemporaryEntries, interruptedCompilerPid, interruptedCompilerAlive, afterInterruption };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const controls = prepareRegressionControls();

test("independent native compilers start together instead of spending the setup budget in sequence", () => {
  const stages = controls.slow.compilerTrace.trim().split("\n").map(line => line.slice(line.indexOf(" ") + 1));
  expect(stages.slice(0, 2).sort()).toEqual(["c++ entered", "rustup entered"]);
  expect(stages.slice(2).sort()).toEqual(["c++ exec", "rustup exec"]);
});

test("native compiler setup can exceed five seconds and report executed controls in agent sessions", () => {
  expectRuntimeControls(controls.slow);
  expect(controls.slow.output).not.toContain("timed out");
  expect(controls.slow.exitCode).toBe(0);
  expect(controls.compileElapsedMs).toBeGreaterThan(6_000);
  expect(controls.slow.leftovers).toEqual([]);
});

test("the compiled finalizer control still rejects destruction under the registry borrow", () => {
  expectCompleted(controls.wrongBorrow, 1);
  expect(controls.wrongBorrow.output).toContain("RefCell already borrowed");
  expect(controls.wrongBorrow.output).toContain(`(fail) ${finalizerTest}`);
  expect(controls.wrongBorrow.exitCode).toBe(1);
  expect(controls.wrongBorrow.leftovers).toEqual([]);
});

test("compiler failure remains blocking and removes partially prepared native controls", () => {
  expectCompleted(controls.failedBuild, 1);
  expect(controls.failedBuild.output).toContain("Received: 7");
  expect(controls.failedBuild.exitCode).toBe(1);
  expect(controls.failedBuild.compilerTrace).toContain("c++ exec");
  expect(controls.failedBuild.elapsedMs).toBeGreaterThan(1_000);
  expect(controls.failedBuild.leftovers).toEqual([]);
});

test("filtering out every runtime test still removes module setup outputs", () => {
  expectCompleted(controls.filtered, 0);
  expect(() => expectRuntimeControls(controls.filtered)).toThrow();
  expect(controls.filtered.output).not.toContain(`(pass) ${finalizerTest}`);
  expect(controls.filtered.exitCode).toBe(0);
  expect(controls.filtered.leftovers).toEqual([]);
});

test("setup results preserve explicit subprocess timeout outcomes", () => {
  const result = Bun.spawnSync([process.execPath, "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], { timeout: 100 });
  const outcome = processOutcome(result);
  expect(outcome.timedOut).toBe(true);
  expect(outcome.signalCode).not.toBeNull();
  expect(outcome.exitCode).not.toBe(0);
  expect(outcome.maxBufferExceeded).toBe(false);
});

test("an interrupted setup removes its temporary files and compiler without contaminating the next control", () => {
  expect(controls.interrupted.signalCode).toBe("SIGKILL");
  expect(controls.interrupted.timedOut).toBe(false);
  expect(controls.interrupted.leftovers.length).toBeGreaterThan(0);
  expect(controls.interruptedTemporaryEntries).toEqual([]);
  expect(controls.interruptedCompilerAlive).toBe(false);
  expectCompleted(controls.afterInterruption, 0);
  expect(controls.afterInterruption.leftovers).toEqual([]);
});

function expectSuccessfulCompilers(result: ReturnType<typeof runControls>): void {
  expect(result.compilerProgress).not.toBeNull();
  for (const compiler of ["c++", "rustup"]) {
    expect(result.compilerProgress).toMatch(new RegExp(`\\d+ ${compiler === "c++" ? "c\\+\\+" : compiler} spawned [1-9]\\d*`));
    expect(result.compilerProgress).toContain(`${compiler} exited 0 -`);
    expect(result.compilerProgress).toContain(`${compiler} stderr-eof 0`);
  }
  if (process.platform === "linux") expect(result.deadline.processes).toEqual([]);
  expect(result.deadline.scanEndedAt).toBeGreaterThanOrEqual(result.deadline.scanStartedAt);
}

test("successful and wrong-borrow controls record independent compiler exit and EOF observations", () => {
  for (const result of [controls.slow, controls.wrongBorrow, controls.afterInterruption]) expectSuccessfulCompilers(result);
  expect(controls.failedBuild.compilerProgress).toContain("rustup exited 7 -");
  expect(controls.failedBuild.compilerProgress).toContain("c++ exited 0 -");
  expect(controls.failedBuild.compilerProgress).toContain("c++ stderr-eof 0");
  expect(controls.failedBuild.compilerProgress).toContain("rustup stderr-eof 0");
});

test("post-return snapshot observes the interrupted owned compiler slot before group teardown", () => {
  if (process.platform !== "linux") return;
  const members = controls.interrupted.deadline.processes;
  expect(members).not.toBeNull();
  const compiler = members?.find(member => member.pid === controls.interruptedCompilerPid);
  expect(compiler).toBeDefined();
  // The wrapper may still be between killing its parent and exec of sleep.
  if (!compiler) throw new Error("Owned compiler slot absent from the available scan");
  expect(["sh", "sleep"]).toContain(compiler.name);
  const group = controls.interrupted.deadline.group;
  if (group === null) throw new Error("Missing spawned group identity");
  expect(compiler.group).toBe(group);
  expect(compiler.group).toBe(compiler.session);
  expect(compiler.group).toBeGreaterThan(0);
  expect(compiler.startTicks).toBeGreaterThan(0);
  expect(controls.interruptedCompilerAlive).toBe(false);
});

test("stat parsing preserves names with parentheses and raw ticks and rejects missing or malformed data", () => {
  const fields = Array.from({ length: 20 }, () => "0");
  fields[0] = "S"; fields[1] = "1"; fields[2] = "42"; fields[3] = "42";
  fields[9] = "3"; fields[11] = "4"; fields[12] = "5"; fields[19] = "12345";
  expect(parseStat(`43 (a name (with) parens) ${fields.join(" ")}`)).toEqual({
    pid: 43, parent: 1, group: 42, session: 42, name: "a name (with) parens", state: "S",
    majorFaults: 3, userTicks: 4, systemTicks: 5, startTicks: 12345,
  });
  expect(parseStat("gone")).toBeNull();
  expect(parseStat("43 (short) S 1")).toBeNull();
  fields[19] = "NaN";
  expect(parseStat(`43 (bad) ${fields.join(" ")}`)).toBeNull();
  expect(readObservation("/proc/0/stat")).toBeNull();
  expect(processObservation("0", 42)).toBeNull();
  expect(scanOwnedGroup(undefined)).toBeNull();
  expect(scratchNames("/proc/0/missing")).toBeNull();
});

test("unavailable progress observations preserve the real outcome and cleanup", () => {
  expectRuntimeControls(controls.unavailableProgress);
  expect(controls.unavailableProgress.compilerProgress).toBeNull();
  expect(controls.unavailableProgress.leftovers).toEqual([]);
  if (process.platform === "linux") expect(controls.unavailableProgress.deadline.processes).toEqual([]);
});
