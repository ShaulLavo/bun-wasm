import assert from "node:assert/strict";
const fixtureStarted = Date.now();
let stage = 0;
function tracedSpawnSync(command: string[], options: Parameters<typeof Bun.spawnSync>[1]) {
  const id = ++stage;
  const started = Date.now();
  console.error(JSON.stringify({ event: "start", id, command, elapsedMs: started - fixtureStarted }));
  const result = Bun.spawnSync(command, options);
  console.error(JSON.stringify({ event: "end", id, elapsedMs: Date.now() - fixtureStarted, durationMs: Date.now() - started, exitCode: result.exitCode }));
  return result;
}
console.error(JSON.stringify({ event: "fixture-start", execPath: process.execPath, cwd: process.cwd() }));

function run(name: string, args: string[] = []) {
  return tracedSpawnSync([process.execPath, "run", name].concat(args), { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
}

for (const [name, output] of [["evaluate", "42"], ["print", "42"], ["cli-flags", "42"], ["ok", "direct file"], ["nodejs-file", "direct file"], ["nodejs-eval", "42"], ["nodejs-named-file", "node filename tail"], ["bun-file", "direct file"], ["bun-alias", "42"], ["node-file", "node filename tail"], ["node-alias-file", "node alias filename tail"]]) {
  const child = run(name);
  assert.equal(child.exitCode, 0, child.stderr.toString());
  assert.equal(child.stdout.toString().trim(), output, name);
}
console.log("package scripts dispatch runtime commands and file aliases");
