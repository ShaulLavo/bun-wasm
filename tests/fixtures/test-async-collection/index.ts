import assert from "node:assert/strict";
import { cases } from "./cases.ts";

function run(name: string, args: string[], pass: number, fail: number, errors: number, events: readonly string[]) {
  const result = Bun.spawnSync([process.execPath, "test"].concat(args), {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, CASE: name, AGENT: "0", NO_COLOR: "1" },
  });
  const stderr = result.stderr.toString();
  assert.equal(result.exitCode, fail || errors ? 1 : 0, stderr);
  assert.match(stderr, new RegExp(` ${pass} pass\\n`));
  assert.match(stderr, new RegExp(` ${fail} fail\\n`));
  if (errors) assert.match(stderr, new RegExp(` ${errors} error\\n`));
  else assert.doesNotMatch(stderr, /^ \d+ errors?$/m);
  const actual = result.stdout.toString().split("\n").filter(line => line.startsWith("event:")).map(line => line.slice(6));
  assert.deepEqual(actual, events, stderr);
  console.log("PASS " + name);
}

for (const scenario of cases) {
  const args = scenario.name === "preload" ? ["--preload", "./preload.ts", "./collect.probe.ts"] : ["./collect.probe.ts"];
  run(scenario.name, args, scenario.pass, scenario.fail, scenario.errors, scenario.events);
}
run("closed-file", ["./late-a.probe.ts", "./late-b.probe.ts"], 2, 0, 0, ["closed file guards and ordinary cleanup"]);
