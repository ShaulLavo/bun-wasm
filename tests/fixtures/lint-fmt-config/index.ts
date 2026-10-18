import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

function project(name: string) {
  mkdirSync(name, { recursive: true });
  writeFileSync(`${name}/input.js`, "debugger;\n");
  return `${process.cwd()}/${name}`;
}
function start(args: string[], cwd = process.cwd()) {
  return Bun.spawn([process.execPath].concat(args), {
    cwd, env: { ...process.env, AGENT: "0", FORCE_COLOR: "0" },
    stdout: "pipe", stderr: "pipe",
  });
}
async function finish(child: ReturnType<typeof start>) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}
async function lint(cwd: string) {
  return finish(start(["lint", "-f", "json", "input.js"], cwd));
}
function diagnosed(result: Awaited<ReturnType<typeof lint>>) {
  assert.equal(result.code, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].messages[0].ruleId, "no-debugger");
}
const healthy = 'export default [{rules:{"no-debugger":"error"}}];';

async function budget() {
  const cwd = project("parallel");
  writeFileSync(`${cwd}/eslint.config.js`, `await Bun.sleep(200); ${healthy}`);
  const children = Array.from({ length: 3 }, () => start(["lint", "-f", "json", "input.js"], cwd));
  for (const result of await Promise.all(children.map(finish))) diagnosed(result);
  console.log("three parallel config-backed commands");
  for (let i = 0; i < 8; i++) diagnosed(await lint(cwd));
  console.log("eight sequential config evaluations");
}

async function ancestors() {
  const parent = project("ancestor");
  const cwd = project("ancestor/local");
  const local = '[lint.rules]\n"no-debugger" = "error"\n';
  writeFileSync(`${cwd}/bunfig.toml`, local);
  for (const invalid of ['[fmt]\nprintWidht = 80\n', '[fmt\n']) {
    writeFileSync(`${parent}/bunfig.toml`, invalid);
    diagnosed(await lint(cwd));
    const required = await finish(start(["lint", "--rule", "bun/format: error", "input.js"], cwd));
    assert.equal(required.code, 2, required.stderr);
    assert.match(required.stderr, /bunfig.toml/);
  }
  writeFileSync(`${cwd}/bunfig.toml`, '[lint.rules]\n"bun/format" = "error"\n');
  const required = await lint(cwd);
  assert.equal(required.code, 2, required.stderr);
  assert.match(required.stderr, /bunfig.toml/);
  console.log("optional ancestors stop silently and required configs fail");
}

async function directories() {
  const parent = project("cwd-project");
  const cwd = project("cwd-project/sub");
  writeFileSync(`${cwd}/bunfig.toml`, '[lint.rules]\n"no-debugger" = "error"\n');
  const checked = await finish(start(["--cwd", parent, "lint", "--cwd", "sub", "-f", "json", "input.js"]));
  diagnosed(checked);
  writeFileSync(`${cwd}/format.ts`, "const value=1;");
  writeFileSync(`${cwd}/.prettierrc.js`, `if (process.argv[1] !== ${JSON.stringify(`--cwd=${parent}`)}) throw new Error("configuration lost top-level arguments"); export default {};`);
  const formatted = await finish(start([`--cwd=${parent}`, "fmt", "--cwd", "sub", "--log-level=warn", "format.ts"]));
  assert.equal(formatted.code, 0, formatted.stderr);
  assert.equal(readFileSync(`${cwd}/format.ts`, "utf8"), "const value = 1;\n");
  console.log("top-level cwd precedes lint and fmt cwd");
}

async function deadline() {
  const cwd = project("deadline");
  writeFileSync(`${cwd}/eslint.config.js`, "for (;;) {}\nexport default [];\n");
  const failed = await lint(cwd);
  assert.equal(failed.code, 2, failed.stderr);
  assert.match(failed.stdout.concat(failed.stderr), /configuration evaluation exceeded.*5 seconds/i);
  writeFileSync(`${cwd}/eslint.config.js`, healthy);
  for (let i = 0; i < 5; i++) diagnosed(await lint(cwd));
  console.log("config deadline reaps the child and healthy commands recover");
}

async function output() {
  const cwd = project("output");
  writeFileSync(`${cwd}/.prettierrc.js`, 'const chunk="x".repeat(65536); for(let i=0;i<80;i++){console.log(chunk);console.error(chunk);} export default {semi:false};');
  const failed = await finish(start(["fmt", "--log-level=warn", "input.js"], cwd));
  assert.equal(failed.code, 2, failed.stderr);
  assert.match(failed.stdout.concat(failed.stderr), /configuration evaluation exceeded.*8 MiB/i);
  assert.ok(failed.stdout.length + failed.stderr.length < 4096);
  writeFileSync(`${cwd}/.prettierrc.js`, "export default {semi:false};");
  for (let i = 0; i < 5; i++) {
    const good = await finish(start(["fmt", "--log-level=warn", "input.js"], cwd));
    assert.equal(good.code, 0, good.stderr);
  }
  assert.equal(readFileSync(`${cwd}/input.js`, "utf8"), "debugger\n");
  console.log("combined config output is bounded and healthy commands recover");
}

const cases = { budget, ancestors, directories, deadline, output };
for (const [name, run] of Object.entries(cases)) {
  if (process.argv[2] && process.argv[2] !== name) continue;
  await run();
}
