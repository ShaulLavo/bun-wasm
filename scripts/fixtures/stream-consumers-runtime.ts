import { spawnSync, type SpawnOptions, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isatty } from "node:tty";
import { createContext, runInContext } from "node:vm";
import type { Readable } from "node:stream";

type ConsumedBlob = {
  readonly size: number;
  readonly type: string;
  text(): Promise<string>;
};

export type Consumers = {
  blob(stream: unknown): Promise<ConsumedBlob>;
  arrayBuffer(stream: unknown): Promise<ArrayBuffer>;
  bytes(stream: unknown): Promise<Uint8Array>;
  buffer(stream: unknown): Promise<Uint8Array>;
  text(stream: unknown): Promise<string>;
  json(stream: unknown): Promise<unknown>;
};

type RuntimeRequire = {
  (name: "node:stream/consumers" | "stream/consumers"): Consumers;
  (name: "node:module"): typeof import("node:module");
  (name: "node:stream"): { Readable: typeof Readable };
  resolve(name: string): string;
};
type Runtime = {
  makeRequire(filename: string): RuntimeRequire;
  initImportMeta(meta: object, filename: string, main: boolean): void;
  runTicks(): void;
  runTimers(): number;
};

export function runOwned(command: string, args: string[], timeout = 4000) {
  const ownsGroup = process.env.BUNWASM_CONSUMERS_CHILD !== "1";
  const options: SpawnSyncOptionsWithStringEncoding & Pick<SpawnOptions, "detached"> = {
    encoding: "utf8", timeout, detached: ownsGroup,
    env: { ...process.env, BUNWASM_CONSUMERS_CHILD: "1" },
  };
  const result = spawnSync(command, args, options);
  if (!ownsGroup || result.pid <= 0) return result;
  try { process.kill(-result.pid, "SIGKILL"); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
  return result;
}

export function sourceModuleTools(scratch: string) {
  const root = resolve(import.meta.dirname, "../..");
  const resolver = readFileSync(join(root, "crates/bunwasm-runtime/src/resolve.rs"), "utf8");
  const modules = readFileSync(join(root, "crates/bunwasm-runtime/src/modules.rs"), "utf8");
  const tables = resolver.slice(resolver.indexOf("pub const NODE_BUILTINS:"), resolver.indexOf("/// Extensions probed"));
  const builtin = resolver.slice(resolver.indexOf("pub fn builtin_name("), resolver.indexOf("/// Lexically normalize"));
  const wrapper = modules.slice(modules.indexOf("fn is_plain_identifier("), modules.indexOf("/// ESM source for a module file:"));
  if (!tables || !builtin || !wrapper) throw new Error("Missing production module functions");
  const source = join(scratch, "module-tools.rs");
  const binary = join(scratch, "module-tools");
  writeFileSync(source, `${tables}\n${builtin}\n${wrapper}\nfn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args[0] == "builtin" {
      for spec in &args[1..] { println!("{}", builtin_name(spec).unwrap_or_default()); }
      return;
    }
    print!("{}", wrapper_source(&args[1..]));
  }\n`);
  const compile = runOwned("rustc", ["--crate-name", "module_tools", "--cfg", 'feature="engine-split"', source, "-o", binary]);
  if (compile.status !== 0) throw new Error(`Compile production module helpers: ${compile.stderr}`, { cause: compile.error });
  return (mode: "builtin" | "wrapper", names: string[]) => {
    const args: string[] = [mode];
    const result = runOwned(binary, args.concat(names), 1000);
    if (result.status !== 0) throw new Error(`Production module helper: ${result.stderr}`, { cause: result.error });
    return result.stdout;
  };
}

export function sourceRuntime(scratch: string) {
  const root = resolve(import.meta.dirname, "../..");
  const directory = join(root, "crates/bunwasm-runtime/src/js");
  const emitted = new Map<string, string>();
  const context = createContext({ queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder });
  function loadPolyfill(name: string) {
    const typed = join(directory, `${name}.ts`);
    let source = emitted.get(name);
    if (source === undefined && existsSync(typed)) {
      const output = join(scratch, `${name}.js`);
      const result = runOwned("node", [join(root, "scripts/transpile-runtime.ts"), typed, output]);
      if (result.status !== 0) throw new Error(`Emit ${name}: ${result.stderr}`, { cause: result.error });
      source = readFileSync(output, "utf8");
    }
    source ??= readFileSync(join(directory, `${name}.js`), "utf8");
    emitted.set(name, source);
    return runInContext(source, context, { filename: `bun-wasm:${name}` });
  }
  const resolver = readFileSync(join(root, "crates/bunwasm-runtime/src/resolve.rs"), "utf8");
  const list = resolver.match(/pub const NODE_BUILTINS: &\[&str\] = &\[([^\]]+)\]/)?.[1];
  if (!list) throw new Error("Missing production builtin resolver table");
  const builtins = new Set(Array.from(list.matchAll(/"([^"]+)"/g), match => match[1]));
  const encoder = new TextEncoder();
  const bootstrap: (native: object) => Runtime = loadPolyfill("bootstrap");
  let tick: () => void;
  const runtime = bootstrap({
    engine: "jsc",
    platformInfo: { version: "1.4.4", arch: "wasm32", os: "linux", revision: "a145d020" },
    mainPath: () => "/entry.ts",
    cwd: () => "/",
    env: () => ({}),
    argv: () => ["bun", "/entry.ts"],
    execArgv: () => [],
    execPath: () => "/bun",
    hostSignal: () => 0,
    hostCaps: {},
    setAsyncContext: (_value: unknown) => {},
    isatty,
    now: () => performance.now(),
    timeOrigin: () => performance.timeOrigin,
    nanoseconds: () => performance.now() * 1e6,
    utf8Encode: (value: string) => encoder.encode(value),
    utf8Decode: (value: Uint8Array, fatal: boolean) => new TextDecoder("utf-8", { fatal, ignoreBOM: true }).decode(value),
    loadPolyfill,
    mapPosition: () => null,
    resolve(specifier: string) {
      const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
      if (!builtins.has(bare)) throw new Error(`No such built-in module: ${specifier}`);
      return `node:${bare}`;
    },
    getAsyncContext: () => undefined,
    scheduleTick: () => queueMicrotask(() => tick()),
  });
  tick = () => runtime.runTicks();
  return {
    context,
    runtime,
    emitted,
    consumers(): Consumers { return runtime.makeRequire("/entry.ts")("node:stream/consumers"); },
    constructors() {
      const require = runtime.makeRequire("/entry.ts");
      const ReadableStream: typeof globalThis.ReadableStream = runInContext("ReadableStream", context);
      return { Readable: require("node:stream").Readable, ReadableStream };
    },
    async run<T>(action: () => Promise<T>): Promise<T> {
      let done = false;
      const result = action();
      void result.then(() => { done = true; }, () => { done = true; });
      while (!done) {
        runtime.runTicks();
        runtime.runTimers();
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      return result;
    },
  };
}
