import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Compilation { command: string; directory: string; file: string }

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function words(command: string): string[] {
  const result = spawnSync("python3", ["-c", "import json,shlex,sys; print(json.dumps(shlex.split(sys.stdin.read())))"], { input: command, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  const value: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(value) || !value.every(word => typeof word === "string")) throw new Error("Invalid compiler arguments");
  return value;
}

function compilations(path: string): Compilation[] {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value)) throw new Error("Invalid compilation database");
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || typeof entry.command !== "string" || typeof entry.directory !== "string" || typeof entry.file !== "string")
      throw new Error("Invalid compilation entry");
    return { command: entry.command, directory: entry.directory, file: entry.file };
  });
}

function compileFlags(entry: Compilation): string[] {
  const flags: string[] = [];
  const args = words(entry.command).slice(1);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (["-c", "-o", "-MF", "-MT", "-MQ"].includes(arg)) { index++; continue; }
    if (["-MD", "-MMD", "-MP"].includes(arg)) continue;
    flags.push(arg);
  }
  return flags;
}

function instrumented(entry: Compilation): boolean {
  if (!entry.file.includes("UnifiedSource-runtime-")) return false;
  const source = readFileSync(entry.file, "utf8");
  return /#include "runtime\/(?:ArrayBuffer|BufferMemoryHandle)\.cpp"/.test(source);
}

function linkFlags(command: string): string[] {
  const args = words(command);
  const start = args.findIndex(arg => arg.endsWith("/clang++"));
  if (start < 0) throw new Error("Missing JSC linker command");
  const end = args.indexOf("&&", start);
  const flags = args.slice(start + 1, end < 0 ? undefined : end);
  const output: string[] = [];
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]!;
    if (flag === "-o") { index++; continue; }
    if (flag.endsWith(".o") || flag.endsWith(".obj")) continue;
    output.push(flag);
  }
  return output;
}

export function nativeBackingControl(options: { root: string; prebuild: string; scratch: string; source: string }): string {
  const build = join(options.prebuild, "build/jsc");
  const entries = compilations(join(build, "compile_commands.json"));
  const shell = entries.find(entry => entry.file.endsWith("/jsc.cpp"));
  if (!shell) throw new Error("Missing JSC shell compile flags");
  const sources = entries.filter(instrumented);
  if (sources.length !== 2) throw new Error(`Expected two native allocation compilation units, got ${sources.length}`);
  const compiler = join(process.env.WASI_SDK_PATH ?? "", "bin/clang++");
  if (!process.env.WASI_SDK_PATH) throw new Error("Source env.sh before native backing controls");
  const objects = sources.map((entry, index) => {
    const output = join(options.scratch, `allocation-${index}.o`);
    run(compiler, compileFlags(entry).concat(["-DBUN_WASM_JSC_RESIZABLE_TESTING=1", "-c", entry.file, "-o", output]), entry.directory);
    return output;
  });
  const control = join(options.scratch, "control.o");
  run(compiler, compileFlags(shell).concat(["-DBUN_WASM_JSC_RESIZABLE_TESTING=1", "-c", options.source, "-o", control]), shell.directory);
  const command = run("ninja", ["-C", build, "-t", "commands", "bin/jsc"], options.root).trim().split("\n").at(-1);
  if (!command) throw new Error("Missing native link recipe");
  const raw = join(options.scratch, "native-control.raw.wasm");
  const final = join(options.scratch, "native-control.wasm");
  run(compiler, objects.concat([control], linkFlags(command), ["-Wl,--export=__stack_pointer", "-o", raw]), build);
  run("bash", [join(options.root, "jsc/finalize.sh"), raw, final], options.root, { ...process.env, JSC_BUILD_DIR: options.prebuild, CAGE: "" });
  const outputs = Array.from({ length: 3 }, () => run("wasmtime", ["run", final], options.root));
  for (const output of outputs) {
    if (!output.includes("Deterministic native backing controls passed")) throw new Error(output);
  }
  return outputs.join("");
}
