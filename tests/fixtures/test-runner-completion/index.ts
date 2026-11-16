import assert from "node:assert/strict";

function run(args: readonly string[]) {
  const child = Bun.spawnSync([process.execPath].concat(args), {
    cwd: import.meta.dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENT: "0", NO_COLOR: "1" },
  });
  return { exit: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

function counts(child: ReturnType<typeof run>, pass: number, fail: number) {
  assert.equal(child.exit, fail ? 1 : 0, child.stderr);
  assert.match(child.stderr, new RegExp(` ${pass} pass\\n`));
  assert.match(child.stderr, new RegExp(` ${fail} fail\\n`));
}

counts(run(["test", "./passing.test.ts"]), 5, 0);
console.log("done completion: 5 pass, 0 fail");
const failed = run(["test", "./failure.test.ts"]);
counts(failed, 1, 8);
for (const label of ["synchronous error after done", "returned rejection after done", "exception in the callback that calls done"]) {
  assert.match(failed.stderr, new RegExp(`\\(fail\\) ${label}`));
}
assert.match(failed.stderr, /timed out after 10ms/);
assert.doesNotMatch(failed.stderr, /Unhandled error between tests/);
console.log("done failures: 1 pass, 8 fail");

const preloaded = run(["test", "--preload", "./setup.ts", "./a.test.ts", "./b.test.ts"]);
counts(preloaded, 2, 0);
assert.deepEqual(preloaded.stdout.trim().split("\n").filter(line => !line.startsWith("bun test ")), [
  "preload evaluated", "test: Cannot use test during preload.", "describe: Cannot use describe during preload.",
  "global setup", "before each", "test a", "after each", "before each", "test b", "after each", "global teardown",
]);
console.log("preload hooks: 2 pass, 0 fail");

const outside = run(["run", "./outside.ts"]);
assert.equal(outside.exit, 0, outside.stderr);
assert.equal(outside.stderr, "");
assert.deepEqual(outside.stdout.trim().split("\n"), [
  'Cannot use test outside of the test runner. Run "bun test" to run tests.',
  'Cannot use describe outside of the test runner. Run "bun test" to run tests.',
  'Cannot use beforeAll() outside of the test runner. Run "bun test" to run tests.',
]);
console.log("registration guards: pass");
