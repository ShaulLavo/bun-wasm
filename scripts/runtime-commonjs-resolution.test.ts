import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { createContext, runInContext } from "node:vm";

const directory = mkdtempSync(join(tmpdir(), "bun-wasm-cjs-resolution-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const filename = join(directory, "entry.cjs");
const nativeRequire = createRequire(filename);
const bootstrapSource = readFileSync(new URL("../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");
const builtinsSource = readFileSync(new URL("../crates/bunwasm-runtime/src/js/builtins.js", import.meta.url), "utf8");

type RuntimeRequire = {
  (specifier: string): unknown;
  resolve(specifier: string): string;
};
type RuntimeMeta = { resolve(specifier: string): string; resolveSync(specifier: string): string; require: RuntimeRequire };
type Runtime = {
  makeRequire(filename: string): RuntimeRequire;
  initImportMeta(meta: object, filename: string, main: boolean): void;
  builtin(name: string): { createRequire(filename: string): RuntimeRequire };
};

const context = createContext({ process, URL });
const bootstrap: (native: object) => Runtime = runInContext(bootstrapSource, context);
const builtins = runInContext(builtinsSource, context);
const resolverSource = readFileSync(new URL("../crates/bunwasm-runtime/src/resolve.rs", import.meta.url), "utf8");
const builtinTable = resolverSource.match(/pub const NODE_BUILTINS: &\[&str\] = &\[([^\]]+)\]/)?.[1];
if (!builtinTable) throw new Error("Missing runtime Node builtin table");
const nodeBuiltins = new Set(Array.from(builtinTable.matchAll(/"([^"]+)"/g), match => match[1]));
const resolutions: string[] = [];
const runtime = bootstrap({
  engine: "host",
  mainPath: () => filename,
  moduleFormat: () => "json",
  modulePath: (name: string) => name,
  readFileUtf8: (path: string) => readFileSync(path, "utf8"),
  resolve(specifier: string, from: string) {
    const resolved = createRequire(from).resolve(specifier);
    const canonical = nodeBuiltins.has(resolved) ? `node:${resolved}` : resolved;
    resolutions.push(canonical);
    return canonical;
  },
  loadPolyfill(name: string) {
    if (name === "builtins") return builtins;
    if (name === "process") return () => process;
    if (name === "console") return () => console;
    if (name === "bun") return () => Bun;
    if (name === "web" || name === "crypto") return () => () => {};
    return () => ({});
  },
});
const require = runtime.makeRequire(filename);

for (const name of ["process", "buffer", "fs", "fs/promises", "path", "module", "assert/strict"]) {
  test(`public require.resolve preserves bare builtin ${name}`, () => {
    expect(require.resolve(name)).toBe(nativeRequire.resolve(name));
    expect(runtime.builtin("node:module").createRequire(filename).resolve(name)).toBe(name);
  });
  test(`public require.resolve preserves explicit node: builtin ${name}`, () => {
    expect(require.resolve(`node:${name}`)).toBe(nativeRequire.resolve(`node:${name}`));
  });
}

for (const name of ["bun", "bun:jsc", "bun:test", "bun:sqlite", "ws", "node:test"]) {
  test(`public require.resolve leaves special builtin ${name} unchanged`, () => {
    expect(require.resolve(name)).toBe(nativeRequire.resolve(name));
  });
}

test("ordinary files and packages still return resolved paths", () => {
  writeFileSync(join(directory, "file.json"), '{"marker":"file"}\n');
  const packageDirectory = join(directory, "node_modules/example");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, "package.json"), '{"main":"index.json"}\n');
  writeFileSync(join(packageDirectory, "index.json"), '{"marker":"package"}\n');
  for (const specifier of ["./file.json", "example"]) {
    expect(require.resolve(specifier)).toBe(nativeRequire.resolve(specifier));
    expect(require(specifier)).toEqual(nativeRequire(specifier));
    expect(require(require.resolve(specifier))).toBe(require(specifier));
  }
});

test("bare and prefixed require still use one canonical builtin instance", () => {
  expect(require("process")).toBe(process);
  expect(require("node:process")).toBe(process);
  expect(resolutions.slice(-2)).toEqual(["node:process", "node:process"]);
});

test("import metadata keeps private canonical resolution", () => {
  const meta: RuntimeMeta = { resolve: () => "", resolveSync: () => "", require };
  runtime.initImportMeta(meta, filename, false);
  expect(meta.resolve("process")).toBe("node:process");
  expect(meta.resolveSync("process")).toBe("node:process");
  expect(meta.require.resolve("process")).toBe("process");
});

const compileFactory = new Bun.Transpiler({ loader: "ts" }).transformSync(
  `globalThis.moduleCompileFactory = ${readFileSync(new URL("../crates/bunwasm-runtime/src/js/module_compile.ts", import.meta.url), "utf8")};`,
);

function moduleHookScenario(program: string): unknown {
  const realm = createContext({ process: { env: {}, pid: 1 }, URL });
  const files = new Map([["/child.cjs", "module.exports.value = 42;"]]);
  function wrapper(file: string) {
    const source = files.get(file);
    if (source === undefined) throw new Error(`Missing hook input ${file}`);
    return runInContext(`(function __bunwasm_cjs__(exports, require, module, __filename, __dirname) { ${source} })`, realm);
  }
  const createBootstrap: (native: object) => { prepareText(source: string): string } = runInContext(bootstrapSource, realm);
  const hooks = createBootstrap({
    engine: "host",
    mainPath: () => "/entry.cjs",
    modulePath: (name: string) => name,
    moduleFormat: () => "cjs",
    cwd: () => "/",
    resolve: (specifier: string) => specifier,
    compileCjs: wrapper,
    evalScript: (source: string, file: string) => runInContext(source, realm, { filename: file }),
    loadPolyfill(name: string) {
      if (name === "builtins") return runInContext(builtinsSource, realm);
      if (name === "module_compile") {
        runInContext(compileFactory, realm);
        return realm.moduleCompileFactory;
      }
      if (name === "path") return () => posix;
      if (name === "process") return () => realm.process;
      if (name === "console") return () => console;
      if (name === "bun") return () => Bun;
      if (name === "web" || name === "crypto") return () => () => {};
      return () => ({});
    },
  });
  hooks.prepareText = source => source;
  realm.runtime = hooks;
  return runInContext(program, realm);
}

const intrinsicCalls = [
  ["uncached require", 'runtime.makeRequire("/entry.cjs")("/child.cjs").value'],
  ["non-ESM import", 'runtime.importNonEsm("/child.cjs", "cjs")[0].value'],
  ["Module._compile", '(() => { const mod = new runtime.Module("/compiled.cjs"); mod._compile("module.exports.value = 42", "/compiled.cjs"); return mod.exports.value; })()'],
];
for (const [name, expression] of intrinsicCalls) {
  test(`CommonJS ${name} ignores application apply hooks`, () => {
    expect(moduleHookScenario(`
      Function.prototype.apply = function () { throw new Error("application apply hook"); };
      Reflect.apply = function () { throw new Error("application reflect hook"); };
      ${expression};
    `)).toBe(42);
  });
}

test("an overridden require accessor is read once after its require function is created", () => {
  expect(moduleHookScenario(`
    const mod = new runtime.Module("/accessor.cjs");
    mod._compile("module.exports = require", "/accessor.cjs");
    const require = mod.exports;
    let reads = 0;
    let receiver;
    Object.defineProperty(mod, "require", { get() {
      reads++;
      return reads === 1 ? function (specifier) { receiver = this; return "intercepted " + specifier; } : undefined;
    }});
    const value = require("virtual");
    ({ value, reads, receiverMatches: receiver === mod });
  `)).toEqual({ value: "intercepted virtual", reads: 1, receiverMatches: true });
});
