import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

function check(args: string[], cwd = process.cwd()) {
  return bun(["check"].concat(args), cwd);
}

function bun(args: string[], cwd = process.cwd()) {
  const result = Bun.spawnSync([process.execPath].concat(args), {
    cwd,
    env: { ...process.env, AGENT: "0", CLAUDECODE: "", FORCE_COLOR: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const tsconfig = JSON.stringify({
  compilerOptions: { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler", lib: ["es2022"], noEmit: true },
  include: ["src"],
});

mkdirSync("app/src", { recursive: true });
writeFileSync("app/tsconfig.json", tsconfig);
writeFileSync("app/src/math.ts", "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
writeFileSync("app/src/index.ts", 'import { add } from "./math";\n\nexport const total: number = add(1, 2);\n');
const clean = check(["--no-pretty"], "app");
assert.equal(clean.code, 0, clean.stdout + clean.stderr);
assert.equal(clean.stdout, "");
console.log("clean project exits 0");

writeFileSync("app/src/index.ts", 'import { add } from "./math";\n\nexport const total: number = add(1, "2");\nexport const label: string = total;\n');
const broken = check(["--no-pretty"], "app");
assert.equal(broken.code, 1, broken.stdout + broken.stderr);
assert.equal(broken.stdout, [
  "src/index.ts(3,37): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  "src/index.ts(4,14): error TS2322: Type 'number' is not assignable to type 'string'.",
  "",
].join("\n"));
console.log("type errors print tsc diagnostics and exit 1");

const pretty = check(["--pretty"], "app");
assert.equal(pretty.code, 1);
assert.ok(pretty.stdout.includes("export const total: number = add(1, \"2\");"), pretty.stdout);
console.log("--pretty shows the source line");

const fromAbove = check(["--no-pretty", "--project", "app"]);
assert.equal(fromAbove.code, 1, fromAbove.stdout + fromAbove.stderr);
assert.ok(fromAbove.stdout.startsWith("app/src/index.ts(3,37): error TS2345"), fromAbove.stdout);
const fromCwd = check(["--cwd", "app", "--no-pretty"]);
assert.equal(fromCwd.stdout, broken.stdout);
console.log("--project and --cwd select the project");

const attached = check(["--no-pretty", "-papp"]);
assert.equal(attached.stdout, fromAbove.stdout);
const aliasFirst = check(["--no-pretty", "--tsconfig-override", "absent", "--project", "app"]);
assert.equal(aliasFirst.stdout, fromAbove.stdout);
const aliasLast = check(["--no-pretty", "--project", "app", "--tsconfig-override", "absent"]);
assert.equal(aliasLast.code, 1);
assert.ok(aliasLast.stdout.includes("TS5058"), aliasLast.stdout);
console.log("-papp, and the last of --project and --tsconfig-override wins");

const globalOverride = bun(["--tsconfig-override", "app/tsconfig.json", "check", "--no-pretty"]);
assert.equal(globalOverride.stdout, fromAbove.stdout);
mkdirSync("fresh/src", { recursive: true });
writeFileSync("fresh/tsconfig.json", tsconfig);
writeFileSync("fresh/src/index.ts", "export const ready: boolean = true;\n");
for (const args of [["check", "-p=", "--no-pretty"], ["check", "--project=", "--no-pretty"], ["--title=check", "check", "--no-pretty"], ["--no-warnings", "check", "--no-pretty"]]) {
  const result = bun(args, "fresh");
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
}
console.log("Bun's own flags before check, and an empty project");

mkdirSync("loose", { recursive: true });
writeFileSync("loose/implicit.ts", "export function twice(value) {\n  return value * 2;\n}\n");
const strict = check(["--no-pretty", "implicit.ts"], "loose");
assert.equal(strict.code, 1, strict.stdout + strict.stderr);
assert.equal(strict.stdout, "implicit.ts(1,23): error TS7006: Parameter 'value' implicitly has an 'any' type.\n");
const lenient = check(["--no-pretty", "--noImplicitAny", "false", "implicit.ts"], "loose");
assert.equal(lenient.code, 0, lenient.stdout + lenient.stderr);
console.log("files without a tsconfig and command-line compiler options");

writeFileSync("loose/check.rsp", "--noImplicitAny\nfalse\nimplicit.ts\n");
const response = check(["--cwd", "loose", "@check.rsp", "--no-pretty"]);
assert.equal(response.code, 0, response.stdout + response.stderr);
console.log("--cwd applies before response files are read");

writeFileSync("entry.ts", 'console.log("entry ran");\n');
const titled = Bun.spawnSync([process.execPath, "--title", "check", "./entry.ts"], { stdout: "pipe", stderr: "pipe" });
assert.equal(titled.exitCode, 0, titled.stderr.toString());
assert.equal(titled.stdout.toString(), "entry ran\n");
writeFileSync("check", 'console.log("node ran the check file");\n');
const node = Bun.spawnSync(["node", "check"], { stdout: "pipe", stderr: "pipe" });
assert.equal(node.exitCode, 0, node.stderr.toString());
assert.equal(node.stdout.toString(), "node ran the check file\n");
writeFileSync("--entry.ts", 'console.log("dash file ran", process.argv.slice(2).join(","));\n');
const dashed = bun(["--", "--entry.ts", "check"]);
assert.equal(dashed.code, 0, dashed.stderr);
assert.equal(dashed.stdout, "dash file ran check\n");
console.log("a flag value, a file after --, or a node script named check is not the command");

const help = check(["--help"]);
assert.equal(help.code, 0);
assert.ok(help.stdout.includes("Usage: bun check"), help.stdout);
const unknown = check(["--no-such-flag"]);
assert.equal(unknown.code, 1);
assert.ok(unknown.stderr.includes("no-such-flag"), unknown.stderr);
console.log("help and unknown flags");
