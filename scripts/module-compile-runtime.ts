import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import * as path from "node:path";
import { createContext, runInContext } from "node:vm";
import { createScriptEvaluation } from "../web/src/script-evaluation.ts";

type CompiledModule = {
  filename: string | null;
  exports: Record<string, unknown>;
  loaded: boolean;
  paths: string[];
  require(specifier: string): unknown;
  _compile(source: string, filename: string): unknown;
};
export type ModuleConstructor = {
  new(id: string): CompiledModule;
  _cache: Record<string, CompiledModule>;
  _nodeModulePaths(directory: string): string[];
};
type Runtime = { builtin(id: string): ModuleConstructor; makeRequire(filename: string): (specifier: string) => Record<string, unknown> };

type ScriptEvaluation = ReturnType<typeof createScriptEvaluation>;
function hostEvaluation(context: ReturnType<typeof createContext>, mapPosition: ScriptEvaluation["mapPosition"] = () => null): ScriptEvaluation {
  const host = readFileSync(new URL("../web/src/engine-host.js", import.meta.url), "utf8");
  const start = host.indexOf("  valueNatives(");
  const end = host.indexOf("  // --- ES modules", start);
  if (start < 0 || end < 0) throw new Error("Missing real Host evaluator methods");
  const methods = host.slice(start, end);
  const evaluator: { valueNatives(mapPosition: ScriptEvaluation["mapPosition"]): ScriptEvaluation } = runInContext(`new (class { o = {}; ${methods} })`, context);
  const natives = evaluator.valueNatives(mapPosition);
  return natives;
}

function runtimeContext() {
  return createContext({
    process, URL, createScriptEvaluation, NativeString: String, transferArrayBuffers: () => {},
    isWasmMemoryBuffer: () => false, nativePromiseHasInstance: () => false,
  });
}

export function productionHostEvaluation(mapPosition: ScriptEvaluation["mapPosition"]): ScriptEvaluation {
  return hostEvaluation(runtimeContext(), mapPosition);
}

function productionRuntime(filename: string, compiledWrapper?: string, realHost = false): Runtime {
  const context = runtimeContext();
  const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
  const source = (name: string) => readFileSync(new URL(name, directory), "utf8");
  const bootstrap: (native: object) => Runtime = runInContext(source("bootstrap.js"), context);
  const builtins = runInContext(source("builtins.js"), context);
  const emittedFactory = process.env.BUNWASM_MODULE_COMPILE_FACTORY;
  if (!emittedFactory) throw new Error("Missing production-erased module_compile factory");
  const runtime = bootstrap({
    engine: "host",
    contextHooks: false,
    prepareVersion: 4,
    preparedColumns: new Map(),
    mapPosition: () => null,
    mainPath: () => filename,
    moduleFormat: (file: string) => file.endsWith(".json") ? "json" : "cjs",
    readFileUtf8: (file: string) => readFileSync(file, "utf8"),
    cwd: () => path.dirname(filename),
    resolve(specifier: string, from: string) {
      const resolved = createRequire(from).resolve(specifier);
      return isBuiltin(resolved) && !resolved.startsWith("node:") ? `node:${resolved}` : resolved;
    },
    compileCjs(file: string) {
      return runInContext(compiledWrapper ?? `(function(exports, require, module, __filename, __dirname) {\n${readFileSync(file, "utf8")}\n})`, context, { filename: file });
    },
    evalScript: (code: string, file: string, firstLine = 1) => runInContext(code, context, { filename: file, lineOffset: firstLine - 1 }),
    loadPolyfill(name: string) {
      if (name === "builtins") return builtins;
      if (name === "process") return () => process;
      if (name === "console") return () => console;
      if (name === "bun") return () => ({});
      if (name === "path") return () => path;
      if (name === "node_fs") return () => ({ fs });
      if (name === "web" || name === "crypto") return () => () => {};
      if (name === "source_prepare") {
        const preparedFactory = process.env.BUNWASM_SOURCE_PREPARE_FACTORY;
        if (!preparedFactory) throw new Error("Missing production-erased source_prepare factory");
        return runInContext(readFileSync(preparedFactory, "utf8"), context);
      }
      if (name === "module_compile") return runInContext(readFileSync(emittedFactory, "utf8"), context);
      return () => ({});
    },
    ...(realHost ? hostEvaluation(context) : {}),
  });
  return runtime;
}

export function productionModule(filename: string, realHost = false): ModuleConstructor {
  return productionRuntime(filename, undefined, realHost).builtin("node:module");
}

export function productionRequire(filename: string, compiledWrapper?: string, realHost = false): Record<string, unknown> {
  return productionRuntime(filename, compiledWrapper, realHost).makeRequire(filename)(filename);
}
