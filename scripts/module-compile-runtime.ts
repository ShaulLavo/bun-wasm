import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import * as nodeModule from "node:module";
import * as path from "node:path";
import { createContext, runInContext } from "node:vm";

export type CompiledModule = {
  filename: string | null;
  exports: Record<string, unknown>;
  loaded: boolean;
  paths: string[];
  _compile(source: string, filename: string): unknown;
};
export type ModuleConstructor = {
  new(id: string): CompiledModule;
  _cache: Record<string, CompiledModule>;
  _nodeModulePaths(directory: string): string[];
};
type Runtime = { builtin(id: string): ModuleConstructor; makeRequire(filename: string): (specifier: string) => Record<string, unknown> };

function productionRuntime(filename: string): Runtime {
  const context = createContext({ process, URL });
  const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
  const source = (name: string) => readFileSync(new URL(name, directory), "utf8");
  const bootstrap: (native: object) => Runtime = runInContext(source("bootstrap.js"), context);
  const builtins = runInContext(source("builtins.js"), context);
  const runtime = bootstrap({
    engine: "host",
    mainPath: () => filename,
    moduleFormat: (file: string) => file.endsWith(".json") ? "json" : "cjs",
    readFileUtf8: (file: string) => readFileSync(file, "utf8"),
    cwd: () => path.dirname(filename),
    resolve(specifier: string, from: string) {
      const resolved = createRequire(from).resolve(specifier);
      return isBuiltin(resolved) && !resolved.startsWith("node:") ? `node:${resolved}` : resolved;
    },
    compileCjs(file: string) {
      return runInContext(`(function(exports, require, module, __filename, __dirname) {\n${readFileSync(file, "utf8")}\n})`, context, { filename: file });
    },
    evalScript: (code: string, file: string) => runInContext(code, context, { filename: file }),
    loadPolyfill(name: string) {
      if (name === "builtins") return builtins;
      if (name === "process") return () => process;
      if (name === "console") return () => console;
      if (name === "bun") return () => ({});
      if (name === "path") return () => path;
      if (name === "node_fs") return () => ({ fs });
      if (name === "web" || name === "crypto") return () => () => {};
      if (name === "module_compile") return runInContext(nodeModule.stripTypeScriptTypes(source("module_compile.ts"), { mode: "strip" }), context);
      return () => ({});
    },
  });
  return runtime;
}

export function productionModule(filename: string): ModuleConstructor {
  return productionRuntime(filename).builtin("node:module");
}

export function productionRequire(filename: string): Record<string, unknown> {
  return productionRuntime(filename).makeRequire(filename)(filename);
}
