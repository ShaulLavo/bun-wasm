import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

function command(tool: string, args: string[], cwd = process.cwd()) {
  const result = Bun.spawnSync([process.execPath, tool].concat(args), {
    cwd,
    env: { ...process.env, AGENT: "0", FORCE_COLOR: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

let loads = 0;
Bun.plugin({ name: "config stand-in", setup(build) {
  build.module("lint-config-package", () => {
    loads++;
    return { loader: "object", exports: { defineConfig: (value: unknown) => value } };
  });
} });
assert.equal(loads, 0);
const objectModule = await import("lint-config-package");
assert.equal(objectModule.defineConfig("value"), "value");
assert.equal(require("lint-config-package"), objectModule.default);
assert.equal(loads, 1);
console.log("runtime object module plugins");

mkdirSync("project", { recursive: true });
writeFileSync("project/input.ts", "debugger;\n");
writeFileSync("project/bunfig.toml", '[lint.rules]\n"no-debugger" = "error"\n');
const lint = command("lint", ["--cwd", "project", "-f", "json", "input.ts"]);
assert.equal(lint.code, 1, lint.stderr);
const reports = JSON.parse(lint.stdout);
assert.equal(reports.length, 1);
assert.equal(reports[0].messages[0].ruleId, "no-debugger");
assert.equal(reports[0].messages[0].line, 1);
console.log("lint native rule and bunfig");

const fixed = command("lint", ["--cwd", "project", "-f", "json", "--rule", "no-debugger: off", "input.ts"]);
assert.equal(fixed.code, 0, fixed.stderr);
assert.equal(JSON.parse(fixed.stdout)[0].messages.length, 0);
console.log("lint CLI overrides config");

const rules = command("lint", ["--rules", "-f", "json"]);
assert.equal(rules.code, 0, rules.stderr);
assert.ok(JSON.parse(rules.stdout).length > 1000);
console.log("lint upstream rule registry");

writeFileSync("project/bunfig.toml", "[fmt]\nsemi = false\nsingleQuote = true\n");
writeFileSync("project/input.ts", 'const value={name:"bun",numbers:[1,2]};');
const formatted = command("fmt", ["--cwd", "project", "--log-level=warn", "input.ts"]);
assert.equal(formatted.code, 0, formatted.stderr);
assert.equal(formatted.stderr, "");
assert.equal(readFileSync("project/input.ts", "utf8"), "const value = { name: 'bun', numbers: [1, 2] }\n");
console.log("fmt upstream TypeScript printer and bunfig");

const checked = command("fmt", ["--cwd", "project", "--check", "--log-level=warn", "input.ts"]);
assert.equal(checked.code, 0, checked.stderr);
writeFileSync("project/input.ts", "const value=1;");
const dirty = command("fmt", ["--cwd", "project", "--check", "--log-level=warn", "input.ts"]);
assert.equal(dirty.code, 1, dirty.stderr);
assert.equal(readFileSync("project/input.ts", "utf8"), "const value=1;");
console.log("fmt check preserves input and reports changes");

const stdin = Bun.spawnSync([process.execPath, "fmt", "--stdin-filepath", "input.ts"], {
  stdin: new TextEncoder().encode("const value=1;"), stdout: "pipe", stderr: "pipe",
});
assert.equal(stdin.exitCode, 0, stdin.stderr.toString());
assert.equal(stdin.stdout.toString(), "const value = 1;\n");
console.log("fmt stdin");

writeFileSync("project/.prettierrc.json", '{"semi":true}');
writeFileSync("project/bunfig.toml", "");
const config = command("fmt", ["--cwd", "project", "--log-level=warn", "input.ts"]);
assert.equal(config.code, 0, config.stderr);
assert.equal(readFileSync("project/input.ts", "utf8"), "const value = 1;\n");
console.log("fmt config evaluation uses the guest runtime");

writeFileSync("project/bunfig.toml", '[fmt]\nsemi = "yes"\n');
const invalid = command("fmt", ["--cwd", "project", "input.ts"]);
assert.equal(invalid.code, 2);
assert.ok(invalid.stderr.includes("bunfig.toml:2:"), invalid.stderr);
console.log("bunfig diagnostics include source locations");

writeFileSync("project/bunfig.toml", "[fmt]\nsemi = true\n");
const doctor = command("fmt", ["--cwd", "project", "--doctor"]);
assert.equal(doctor.code, 0, doctor.stderr);
assert.ok(doctor.stdout.includes("Using bunfig.toml ([fmt])"), doctor.stdout);
console.log("doctor uses relative bunfig paths");

writeFileSync("project/input.ts", "const value=2;");
const colored = Bun.spawnSync([process.execPath, "fmt", "--cwd", "project", "--check"], {
  env: { ...process.env, AGENT: "0", FORCE_COLOR: "1", NO_COLOR: "0" },
  stdout: "pipe", stderr: "pipe",
});
assert.equal(colored.exitCode, 1, colored.stderr.toString());
assert.match(colored.stderr.toString(), /\x1b\[/);
console.log("formatter honors FORCE_COLOR");
