import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const excludedJscSentinels = ["icu/host-src/source/sentinel", "icu/wasm-src/source/sentinel", "icu/data/sentinel", "icu/icu4c-78.3-sources.tgz", "gems/sentinel", "configure.log", "icu/host-configure.log", "icu/wasm-make.log"];
export const excludedJscRoots = ["icu/host-src", "icu/wasm-src", "icu/data", "icu/icu4c-78.3-sources.tgz", "gems", "configure.log", "icu/host-configure.log", "icu/wasm-make.log"];
export const excludedSharedSentinels = ["libcxx/build/sentinel", "libcxx/llvm-project/.git/sentinel", "libcxx/llvm-project/libcxx/sentinel", "libcxx/configure.log", "libcxx/build.log"];

export function seedJscArtifact(root: string, shared = false): void {
  const files = ["build/jsc/lib/libJavaScriptCore.a", "build/jsc/lib/libWTF.a", "build/jsc/lib/libbmalloc.a", "icu/.bunwasm-inputs", "icu/prefix/lib/libicuuc.a", "icu/prefix/lib/libicui18n.a", "icu/prefix/lib/libicudata.a", "icu/prefix/include/unicode/utypes.h", "shim/libwasi-compat.a", "inputs/wasi-jsc.cmake", "inputs/shim/wasi-compat.h", "inputs/shim/wasi-compat.c", "inputs/shim/madvise.c", "build/jsc/cmakeconfig.h", "build/jsc/CMakeFiles/rules.ninja", "build/jsc/Source/JSCBuiltins.cpp.obj", "build/jsc/.ninja_deps", "build/jsc/.ninja_log", "build/jsc/headers.hmap", "webkit/.git/HEAD", "webkit/.git/index", "webkit/.git/config", "webkit/.git/info/sparse-checkout", "webkit/Source/JavaScriptCore/runtime/OptionsList.h", "build/jsc/JavaScriptCore/DerivedSources/yarr/YarrCanonicalizeUnicode.cpp"];
  const yarr = ["YarrPattern.cpp", "YarrInterpreter.cpp", "YarrCanonicalizeUCS2.cpp", "YarrErrorCode.cpp", "YarrFlags.cpp", "YarrUnicodeProperties.cpp"];
  const metadata = ["CMakeCCompiler.cmake", "CMakeCXXCompiler.cmake", "CMakeSystem.cmake"];
  const profile = shared ? ["libcxx/lib/libc++.a", "libcxx/lib/libc++abi.a", "libcxx/include/__config_site", "libcxx/.bunwasm-inputs", "libcxx/.bunwasm-archives"] : ["jsc.wasm"];
  for (const path of files.concat(profile, yarr.map(name => `webkit/Source/JavaScriptCore/yarr/${name}`), metadata.map(name => `build/jsc/CMakeFiles/4.4.5/${name}`), excludedJscSentinels, shared ? excludedSharedSentinels : [])) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `synthetic fixture ${path}\n`);
  }
  mkdirSync(join(root, "webkit/.git/objects"), { recursive: true });
  writeFileSync(join(root, "build/jsc/.bunwasm-inputs"), "expected-inputs");
  writeFileSync(join(root, "build/jsc/CMakeCache.txt"), ["CMAKE_CACHE_MAJOR_VERSION:INTERNAL=4", "CMAKE_CACHE_MINOR_VERSION:INTERNAL=4", "CMAKE_CACHE_PATCH_VERSION:INTERNAL=5", `CMAKE_TOOLCHAIN_FILE:FILEPATH=${root}/inputs/wasi-jsc.cmake`, ""].join("\n"));
  writeFileSync(join(root, "build/jsc/compile_commands.json"), JSON.stringify([{ directory: join(root, "build/jsc"), file: `${root}/webkit/Source/JavaScriptCore/jsc.cpp`, command: `clang++ -I${root}/build/jsc -I ${root}/icu/prefix/include -isystem ${root}/webkit/Source -iquote ${root}/build/jsc/absent-search -include ${root}/inputs/shim/wasi-compat.h` }]));
  const artifact = "build/jsc/lib/libJavaScriptCore.a";
  const digest = new Bun.CryptoHasher("sha256").update(`synthetic fixture ${artifact}\n`).digest("hex");
  writeFileSync(join(root, ".bunwasm-artifacts"), `${digest}  ${root}/${artifact}\n`);
}
