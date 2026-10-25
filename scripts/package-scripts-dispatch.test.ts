import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/package_scripts.ts", import.meta.url), "utf8");
const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.packageFactory = ${source}`));
const projects: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true }); });

function fixture(scripts: Record<string, string>, name: string, args: string[] = [], exitCode = 0) {
  const cwd = mkdtempSync(path.join(tmpdir(), "bun-wasm-scripts-"));
  projects.push(cwd);
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(path.join(cwd, "app.js"), "console.log('file');");
  const process = { env: { PATH: "/bin:/usr/bin" }, argv: ["bun", name].concat(args), execPath: "/bin/bun", cwd: () => cwd };
  const native = {
    mainArg: () => name, exists: existsSync, readFileUtf8: (file: string) => readFileSync(file, "utf8"),
    stat: (file: string, link = false) => link ? lstatSync(file) : statSync(file), readlink: readlinkSync,
    readdir: (directory: string) => readdirSync(directory, { withFileTypes: true }).map(entry => [entry.name, entry.isDirectory() ? "dir" : "file"]),
    resolve: (file: string) => file, setMainPath() {},
  };
  const launches: Array<{ argv: string[]; options: Record<string, unknown> }> = [];
  function require(name: string) {
    if (name === "process") return process;
    if (name !== "spawn") return path;
    return { spawn(argv: string[], options: Record<string, unknown>) { launches.push({ argv, options }); return { exited: Promise.resolve(exitCode) }; } };
  }
  const packages = factory({ native, require });
  return { packages, process, cwd, launches, resolve: () => packages.resolve(path.join(cwd, name)) };
}

test("conventional bun test reaches the runtime dispatcher once", () => {
  const f = fixture({ test: "bun test ./sample.test.ts" }, "test", ["--timeout", "1000"]);
  expect(f.resolve()).toEqual({ kind: "runtime", argv: ["bun", "test", "./sample.test.ts", "--timeout", "1000"] });
});

for (const executable of ["bun", "node", "nodejs", "/bin/node"]) test(`${executable} eval retains its source operand and argv`, () => {
  const f = fixture({ evaluate: `${executable} -e "console.log(42)"` }, "evaluate", ["tail"]);
  expect(f.resolve()).toEqual({ kind: "runtime", argv: [executable, "-e", "console.log(42)", "tail"] });
});

for (const command of ["node -p '21 * 2'", "bun --no-install --smol run -p '21 * 2'", "bun build app.js --outdir out", "bun install --frozen-lockfile"]) {
  test(`retains runtime command ${command}`, () => {
    const f = fixture({ command }, "command");
    expect(f.resolve().kind).toBe("runtime");
  });
}

test("direct runtime file is not reinterpreted as a package script", () => {
  const f = fixture({ start: "node app.js", "app.js": "bun run start" }, "start", ["one two"]);
  expect(f.resolve()).toEqual({ kind: "runtime", argv: ["node", "app.js", "one two"] });
});

test("explicit aliases keep argument ordering and lifecycle environment", () => {
  const f = fixture({ start: "MODE=outer bun --smol run inner first", inner: "MARK=inner node ./app.js second" }, "start", ["tail"]);
  expect(f.resolve()).toEqual({ kind: "runtime", argv: ["node", "./app.js", "second", "first", "tail"] });
  expect(f.process.env).toMatchObject({ MODE: "outer", MARK: "inner", npm_lifecycle_event: "inner", npm_lifecycle_script: "MARK=inner node ./app.js second", npm_execpath: "/bin/bun" });
});

const cycles: Record<string, string>[] = [{ a: "bun run a" }, { a: "bun -- a" }, { a: "bun run b", b: "bun run a" }, { a: "bun beta", beta: "bun alpha", alpha: "bun beta" }];
for (const scripts of cycles) test(`genuine alias cycle ${JSON.stringify(scripts)}`, () => {
  expect(() => fixture(scripts, "a").resolve()).toThrow("Package script alias cycle");
});

test("an acyclic alias chain is not rejected at an arbitrary depth", () => {
  const scripts = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`s${index}`, `bun run s${index + 1}`]));
  scripts.s40 = "node ./app.js";
  expect(fixture(scripts, "s0").resolve()).toEqual({ kind: "runtime", argv: ["node", "./app.js"] });
});

test("explicit run of a file bypasses a same-named bare script", () => {
  const f = fixture({ start: "bun run ./app.js", "app.js": "bun run start" }, "start");
  expect(f.resolve()).toEqual({ kind: "runtime", argv: ["bun", "run", "./app.js"] });
});

test("PATH command precedence and direct entry precedence remain distinct", () => {
  const f = fixture({ start: "tool fixed" }, "start", ["tail"]);
  const bin = path.join(f.cwd, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "tool"), "console.log('bin');");
  writeFileSync(path.join(f.cwd, "tool"), "console.log('local');");
  expect(f.resolve()).toBe(path.join(bin, "tool"));
  expect(f.process.argv.slice(1)).toEqual([path.join(bin, "tool"), "fixed", "tail"]);
  expect(f.process.env.PATH.startsWith(`${bin}:`)).toBe(true);
  const direct = fixture({}, "app.js");
  expect(direct.resolve()).toBe(path.join(direct.cwd, "app.js"));
});


test("runMain forwards a runtime invocation without loading it as a module", async () => {
  const f = fixture({ evaluate: "VALUE=kept node -e 'console.log(42)'" }, "evaluate", ["tail"], 17);
  const bootstrap = readFileSync(new URL("../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");
  const start = bootstrap.indexOf("  internal.runMain =");
  const end = bootstrap.indexOf("  internal.getMainModule", start);
  const internal = { require: () => f.packages, runMain: (_requested: string): Promise<void> => Promise.resolve() };
  runInNewContext(bootstrap.slice(start, end), { internal, native: { exists() { throw new Error("runtime command reached the module loader"); } } });
  await internal.runMain(path.join(f.cwd, "evaluate"));
  expect(f.launches).toEqual([{ argv: ["node", "-e", "console.log(42)", "tail"], options: {
    cwd: f.cwd, env: f.process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  } }]);
  expect(f.process).toMatchObject({ exitCode: 17 });
});

test("implicit aliases reserve every CLI command, including unsupported commands", () => {
  const cli = readFileSync(new URL("../crates/bunwasm-cli/src/main.rs", import.meta.url), "utf8");
  const parser = cli.slice(cli.indexOf("fn parse_command("), cli.indexOf("// Referenced so the linker"));
  const commands = Array.from(parser.matchAll(/"([a-z][a-z-]*)"/g), match => match[0].slice(1, -1)).filter(name => name !== "run");
  for (const name of new Set(commands)) {
    const f = fixture({ start: `bun ${name}`, [name]: "bun run start" }, "start");
    expect(f.resolve()).toEqual({ kind: "runtime", argv: ["bun", name] });
  }
});

test("native Bun and Node references run conventional test, eval, print and direct-file scripts", () => {
  const f = fixture({ test: "bun test ./sample.test.ts", evaluate: 'node -e "console.log(42)"', print: 'node -p "21 * 2"', ok: "node ./app.js", "nodejs-file": "nodejs ./app.js", "nodejs-eval": 'nodejs -e "console.log(42)"' }, "test");
  const node = Bun.which("node");
  if (!node) throw new Error("Native Node reference executable is required");
  const bin = path.join(f.cwd, "reference-bin");
  mkdirSync(bin);
  symlinkSync(node, path.join(bin, "nodejs"));
  writeFileSync(path.join(f.cwd, "sample.test.ts"), 'import { test, expect } from "bun:test"; test("conventional", () => { expect(1).toBe(1); console.log("test ran once"); });');
  for (const [name, output] of [["test", "test ran once"], ["evaluate", "42"], ["print", "42"], ["ok", "file"], ["nodejs-file", "file"], ["nodejs-eval", "42"]] satisfies Array<[string, string]>) {
    const child = Bun.spawnSync([process.execPath, "run", name], { cwd: f.cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim().split("\n").filter(line => !line.startsWith("bun test v")).join("\n")).toBe(output);
  }
});


test("native Bun distinguishes direct files from explicit run aliases", () => {
  const f = fixture({ "app.js": 'node -e "console.log(42)"' }, "app.js");
  for (const [args, output] of [[["app.js"], "file"], [["run", "app.js"], "42"]] satisfies Array<[string[], string]>) {
    const child = Bun.spawnSync([process.execPath].concat(args), { cwd: f.cwd, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim()).toBe(output);
  }
});


test("Bun direct files win over implicit aliases, but explicit run selects a script", () => {
  const f = fixture({ start: "bun app.js", "app.js": 'node -e "console.log(42)"' }, "start");
  expect(f.resolve()).toEqual({ kind: "runtime", argv: ["bun", "app.js"] });
  const explicit = fixture({ start: "bun run app.js", "app.js": 'node -e "console.log(42)"' }, "start");
  expect(explicit.resolve()).toEqual({ kind: "runtime", argv: ["node", "-e", "console.log(42)"] });
});
