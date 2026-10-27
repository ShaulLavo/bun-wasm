import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

function run(name: string, args: string[] = []) {
  return Bun.spawnSync([process.execPath, "run", name].concat(args), { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
}

for (const [name, output] of [["evaluate", "42"], ["print", "42"], ["cli-flags", "42"], ["ok", "direct file"], ["nodejs-file", "direct file"], ["nodejs-eval", "42"], ["nodejs-named-file", "node filename tail"], ["bun-file", "direct file"], ["bun-alias", "42"], ["node-file", "node filename tail"], ["node-alias-file", "node alias filename tail"]]) {
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
assert.equal(run("nodejs-exit").exitCode, 17);
const syntax = run("shell-syntax");
assert.equal(syntax.exitCode, 0, syntax.stderr.toString());
assert.equal(syntax.stdout.toString(), "one\nTWO SHELL-SYNTAX\nthree\n");
const hooked = run("hooked");
assert.equal(hooked.stdout.toString(), "pre\nmain\npost\n");
assert.equal(hooked.stderr.toString(), "$ echo pre\n$ echo main\n$ echo post\n");
const silent = Bun.spawnSync([process.execPath, "run", "--silent", "exit"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
assert.equal(silent.exitCode, 17);
assert.equal(silent.stderr.toString(), "");
const inspected = run("alias", ["tail"]);
assert.equal(inspected.exitCode, 0, inspected.stderr.toString());
assert.equal(inspected.stdout.toString().trim(), "inspect second|first|tail outer inner true");
mkdirSync("node_modules/.bin", { recursive: true });
try {
  writeFileSync("node_modules/.bin/tool", '#!/bin/node\nconsole.log("installed", process.argv.slice(2).join("|"));');
  writeFileSync("tool", 'console.log("local");');
  const binary = run("bin-script", ["tail"]);
  assert.equal(binary.exitCode, 0, binary.stderr.toString());
  assert.equal(binary.stdout.toString().trim(), "installed baked|tail");
  const entry = run("tool");
  assert.equal(entry.exitCode, 0, entry.stderr.toString());
  assert.equal(entry.stdout.toString().trim(), "local");
} finally {
  rmSync("node_modules", { recursive: true, force: true });
  rmSync("tool", { force: true });
}
console.log("package scripts run in bash-web with runtime commands, argv, environment, PATH and exit status");
