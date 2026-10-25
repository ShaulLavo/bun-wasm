import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/package_scripts.ts", import.meta.url), "utf8");
const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.packageFactory = ${source}`));
const projects: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true }); });

function fixture(scripts: Record<string, string>, name: string, args: string[] = []) {
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
  const packages = factory({ native, require: (name: string) => name === "process" ? process : path });
  return { packages, process, cwd, resolve: () => packages.resolve(path.join(cwd, name)) };
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

for (const scripts of [{ a: "bun run a" }, { a: "bun run b", b: "bun run a" }, { a: "bun b", b: "bun a" }]) test(`genuine alias cycle ${JSON.stringify(scripts)}`, () => {
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
