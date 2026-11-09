import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const finalizerTest = "deferred native destruction permits destructor reentry into the registry";
const commonjsTest = "the real CommonJS wrapper keeps its exact body and other negative shapes reject";
const inputs = [
  "scripts/spidermonkey-semantics.test.ts",
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

function runControls(root: string, args: readonly string[] = []) {
  const trace = join(root, "compiler.trace");
  writeFileSync(trace, "");
  const started = performance.now();
  const result = Bun.spawnSync([process.execPath, "test", "./scripts/spidermonkey-semantics.test.ts"].concat(args), {
    cwd: root,
    env: { ...process.env, TMPDIR: join(root, "tmp"), PATH: `${join(root, "bin")}:${process.env.PATH}`, BUN_WASM_SM_COMPILER_TRACE: trace },
    timeout: 30_000,
  });
  return {
    ...processOutcome(result),
    elapsedMs: performance.now() - started,
    output: result.stdout.toString() + result.stderr.toString(),
    leftovers: readdirSync(join(root, "tmp")),
    compilerTrace: readFileSync(trace, "utf8"),
    compilerCommands: { cxx: readFileSync(join(root, "bin/c++"), "utf8"), rustup: readFileSync(join(root, "bin/rustup"), "utf8") },
  };
}

function expectCompleted(result: ReturnType<typeof runControls>, exitCode: number): void {
  expect(result, JSON.stringify(result, null, 2)).toMatchObject({ exitCode, signalCode: null, timedOut: false, maxBufferExceeded: false });
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
    const slow = runControls(root);
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
    return { slow, compileElapsedMs, wrongBorrow, filtered, failedBuild };
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

test("native compiler setup can exceed five seconds without consuming either runtime deadline", () => {
  expectCompleted(controls.slow, 0);
  expect(controls.slow.output).toContain(`(pass) ${commonjsTest}`);
  expect(controls.slow.output).toContain(`(pass) ${finalizerTest}`);
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
