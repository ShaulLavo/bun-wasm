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
  writeFileSync(join(directory, name), `#!/bin/sh\n${prelude}\nexec ${quoted} "$@"\n`, { mode: 0o755 });
}

function runControls(root: string, args: readonly string[] = []) {
  const result = Bun.spawnSync([process.execPath, "test", "./scripts/spidermonkey-semantics.test.ts"].concat(args), {
    cwd: root,
    env: { ...process.env, TMPDIR: join(root, "tmp"), PATH: `${join(root, "bin")}:${process.env.PATH}` },
    timeout: 30_000,
  });
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString(), leftovers: readdirSync(join(root, "tmp")) };
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

    compilerWrapper(join(root, "bin"), "rustup", "exit 7");
    const failedBuild = runControls(root);
    return { slow, compileElapsedMs, wrongBorrow, filtered, failedBuild };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const controls = prepareRegressionControls();

test("native compiler setup can exceed five seconds without consuming either runtime deadline", () => {
  expect(controls.slow.output).toContain(`(pass) ${commonjsTest}`);
  expect(controls.slow.output).toContain(`(pass) ${finalizerTest}`);
  expect(controls.slow.output).not.toContain("timed out");
  expect(controls.slow.exitCode).toBe(0);
  expect(controls.compileElapsedMs).toBeGreaterThan(12_000);
  expect(controls.slow.leftovers).toEqual([]);
});

test("the compiled finalizer control still rejects destruction under the registry borrow", () => {
  expect(controls.wrongBorrow.output).toContain("RefCell already borrowed");
  expect(controls.wrongBorrow.output).toContain(`(fail) ${finalizerTest}`);
  expect(controls.wrongBorrow.exitCode).toBe(1);
  expect(controls.wrongBorrow.leftovers).toEqual([]);
});

test("compiler failure remains blocking and removes partially prepared native controls", () => {
  expect(controls.failedBuild.output).toContain("Received: 7");
  expect(controls.failedBuild.exitCode).toBe(1);
  expect(controls.failedBuild.leftovers).toEqual([]);
});

test("filtering out every runtime test still removes module setup outputs", () => {
  expect(controls.filtered.output).not.toContain(`(pass) ${finalizerTest}`);
  expect(controls.filtered.exitCode).toBe(0);
  expect(controls.filtered.leftovers).toEqual([]);
});
