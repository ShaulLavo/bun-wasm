import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { commands, fileHash, performanceProfile, type CompileCommand } from "./native-profile.ts";

export function checkDiagnosticMacros(text: string, debug: boolean) {
  const macros = new Map(Array.from(text.matchAll(/^#define (\w+)([^\n]*)$/gm), match => [match[1]!, match[2]!.trim()]));
  assert.equal(macros.has("JS_CRASH_DIAGNOSTICS"), debug, "unexpected effective JS_CRASH_DIAGNOSTICS");
  for (const name of ["MOZ_DIAGNOSTIC_ASSERT_ENABLED", "MOZ_RELEASE_ASSERT", "MOZ_CRASH", "NIGHTLY_BUILD", "__wasi__", "BUNWASM_EMBED"]) {
    assert(macros.has(name), `missing effective ${name}`);
  }
  assert.equal(macros.has("DEBUG"), debug, "unexpected effective DEBUG");
  return Object.fromEntries(["JS_CRASH_DIAGNOSTICS", "MOZ_DIAGNOSTIC_ASSERT_ENABLED", "MOZ_RELEASE_ASSERT", "MOZ_CRASH", "DEBUG", "NIGHTLY_BUILD", "__wasi__", "BUNWASM_EMBED"]
    .map(name => [name, macros.get(name) ?? null]));
}

function preprocessingArguments(entry: CompileCommand): string[] {
  const result: string[] = [];
  for (let index = 1; index < entry.arguments.length; index++) {
    const arg = entry.arguments[index]!;
    if (["-o", "-MF", "-MT", "-MQ"].includes(arg)) { index++; continue; }
    if (["-c", "-MD", "-MMD", "-MP"].includes(arg)) continue;
    if (resolve(entry.directory, arg) === resolve(entry.directory, entry.file)) continue;
    result.push(arg);
  }
  return result.concat(["-E", "-dM", "-x", "c++", "-"]);
}

function preprocess(compiler: string, args: string[], directory: string, header: string, debug: boolean) {
  const flags = debug ? args.concat(["-DDEBUG=1", "-DJS_DEBUG=1"]) : args;
  const text = execFileSync(compiler, flags, { cwd: directory, input: `#include ${JSON.stringify(header)}\n`, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return { compiler, arguments: flags, macros: checkDiagnosticMacros(text, debug) };
}

export function verifyDiagnosticProfile(root: string, sdk: string, sysroot: string, include = join(root, "obj/dist/include"), confdefs = join(root, "obj/js/src/js-confdefs.h")) {
  const raw: unknown = JSON.parse(readFileSync(join(root, "obj/clangd/compile_commands.json"), "utf8"));
  const entry = commands(raw).find(command => command.arguments[0] === join(sdk, "bin/clang++") && command.file.includes("/js/src/") && command.file.endsWith(".cpp"));
  assert(entry, "missing library C++ command for actual header preprocessing");
  const header = join(root, "firefox/js/src/util/DiagnosticAssertions.h");
  const libraryArgs = preprocessingArguments(entry);
  const embeddingArgs = ["--target=wasm32-wasip1", `--sysroot=${sysroot}`, "-I", include, "-include", confdefs,
    "-fPIC", "-fno-exceptions", "-fno-rtti", "-std=c++20", "-DBUNWASM_EMBED=1"];
  if (entry.arguments.includes("-DBUN_WASM_SHARED_GROUP=1")) embeddingArgs.push("-matomics", "-mbulk-memory", "-mmutable-globals", "-DBUN_WASM_SHARED_GROUP=1");
  embeddingArgs.push("-E", "-dM", "-x", "c++", "-");
  const compiler = join(sdk, "bin/clang++");
  return {
    profile: performanceProfile, headerSha256: fileHash(header), confdefsSha256: fileHash(confdefs),
    library: preprocess(compiler, libraryArgs, entry.directory, header, false),
    embedding: preprocess(compiler, embeddingArgs, root, header, false),
    debugLibrary: preprocess(compiler, libraryArgs, entry.directory, header, true),
    debugEmbedding: preprocess(compiler, embeddingArgs, root, header, true),
  };
}
