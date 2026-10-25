import assert from "node:assert/strict";

function run(name: string, args: string[] = []) {
  return Bun.spawnSync([process.execPath, "run", name].concat(args), { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
}

for (const [name, output] of [["evaluate", "42"], ["print", "42"], ["cli-flags", "42"], ["ok", "direct file"], ["node-file", "node filename tail"], ["node-alias-file", "node alias filename tail"]]) {
  const child = run(name);
  assert.equal(child.exitCode, 0, child.stderr.toString());
  assert.equal(child.stdout.toString().trim(), output, name);
}
const passed = run("test", ["--test-name-pattern", "conventional"]);
assert.equal(passed.exitCode, 0, passed.stderr.toString());
assert.equal(passed.stdout.toString().trim().split("\n").filter(line => line === "test once").length, 1);
const failed = run("failed-test");
assert.equal(failed.exitCode, 1, failed.stderr.toString());
assert.equal(run("exit").exitCode, 17);
for (const name of ["cycle-a", "implicit-a"]) {
  const cycle = run(name);
  assert.equal(cycle.exitCode, 1);
  assert.ok(cycle.stderr.toString().includes("Package script alias cycle"), cycle.stderr.toString());
}
const inspected = run("alias", ["tail"]);
assert.equal(inspected.exitCode, 0, inspected.stderr.toString());
assert.equal(inspected.stdout.toString().trim(), "inner second|first|tail outer inner true");
console.log("package scripts preserve runtime commands, argv, environment, PATH and exit status");
