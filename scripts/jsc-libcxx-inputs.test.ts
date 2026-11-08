import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureGit } from "../tests/package/guest-receipt-fixture";

type Harness = { root: string; source: string; sdk: string; libcxx: string; invoke: (env?: NodeJS.ProcessEnv) => { exitCode: number; stderr: Uint8Array } };
const recipe = readFileSync(new URL("../jsc/build-libcxx.sh", import.meta.url), "utf8");
function executable(path: string, text: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${text}\n`, { mode: 0o755 });
}
function seedSource(root: string): { source: string; commit: string } {
  const source = join(root, "libcxx/llvm-project");
  for (const path of [source, join(source, "runtimes"), join(source, "libcxx"), join(source, "libcxxabi"), join(root, "patches")]) mkdirSync(path, { recursive: true });
  fixtureGit(source, "init", "-b", "fixture");
  fixtureGit(source, "config", "user.name", "libcxx fixture");
  fixtureGit(source, "config", "user.email", "fixture@example.invalid");
  for (const file of ["libcxx/a.txt", "libcxxabi/b.txt"]) writeFileSync(join(source, file), "before\n");
  fixtureGit(source, "add", ".");
  fixtureGit(source, "commit", "-m", "fixture LLVM source");
  const changes: readonly (readonly [string, string])[] = [["libcxx/a.txt", "llvm-pr-186054"], ["libcxxabi/b.txt", "llvm-undo-part-of-194317"]];
  for (const [file, patch] of changes) {
    writeFileSync(join(source, file), "after\n");
    writeFileSync(join(root, "patches", `${patch}.patch`), fixtureGit(source, "diff", "--", file) + "\n");
    fixtureGit(source, "checkout", "--", file);
  }
  return { source, commit: fixtureGit(source, "rev-parse", "HEAD") };
}
function prepare(root: string): Harness {
  for (const path of ["jsc", "bin", "sdk/bin", "sdk/share/cmake", "sdk/share/wasi-sysroot/include/wasm32-wasip1/noeh/c++/v1", "sysroot/include", "sysroot/lib/wasm32-wasip1"]) mkdirSync(join(root, path), { recursive: true });
  const { source, commit } = seedSource(root);
  const sdk = join(root, "sdk"), libcxx = join(root, "libcxx"), config = join(sdk, "share/wasi-sysroot/include/wasm32-wasip1/noeh/c++/v1/__config_site");
  expect(recipe).toContain("llvm_commit=895aa2c896ada719451be2e3673c83da8ddf1141");
  writeFileSync(join(root, "jsc/build-libcxx.sh"), recipe.replace("llvm_commit=895aa2c896ada719451be2e3673c83da8ddf1141", `llvm_commit=${commit}`));
  writeFileSync(join(root, "jsc/common.sh"), `set -euo pipefail\nJSC_PROFILE=shared-group\nJSC_PROFILE_FLAGS='-matomics -mbulk-memory -mmutable-globals -DBUN_WASM_SHARED_GROUP=1'\nJSC_SRC=${JSON.stringify(join(root, "jsc"))}\nLIBCXX_DIR=${JSON.stringify(libcxx)}\nWASI_SDK_PATH=${JSON.stringify(sdk)}\nBUN_WASM_SYSROOT=${JSON.stringify(join(root, "sysroot"))}\nJOBS=2\nCAGE=''\n`);
  writeFileSync(config, "fixture ABI\n");
  writeFileSync(join(sdk, "VERSION"), "fixture SDK\n");
  writeFileSync(join(sdk, "share/cmake/WASI.cmake"), "fixture cmake\n");
  writeFileSync(join(root, "sysroot/include/stdlib.h"), "fixture header\n");
  writeFileSync(join(root, "sysroot/lib/wasm32-wasip1/libc.a"), "fixture libc\n");
  writeFileSync(join(root, "sysroot/bun-wasm-sysroot.json"), "fixture receipt\n");
  for (const tool of ["clang", "clang++", "llvm-ar", "llvm-ranlib"]) executable(join(sdk, "bin", tool), "echo 'fixture compiler 1'");
  executable(join(root, "bin/curl"), `output= url=\nwhile [[ $# -gt 0 ]]; do\n  case "$1" in -o) output=$2; shift 2 ;; https://*) url=$1; shift ;; *) shift ;; esac\ndone\ncp "$FIXTURE_PATCHES/\${url##*/}" "$output"`);
  executable(join(root, "bin/cmake"), `if [[ $1 == --version ]]; then echo 'fixture cmake 1'; exit 0; fi\nprintf 'configure\\n' >> "$FIXTURE_CALLS"\nmkdir -p "$FIXTURE_OBJECTS/libcxx/include/c++/v1"\ncp "$FIXTURE_CONFIG" "$FIXTURE_OBJECTS/libcxx/include/c++/v1/__config_site"`);
  executable(join(root, "bin/ninja"), `if [[ $1 == --version ]]; then echo 'fixture ninja 1'; exit 0; fi\nprintf 'build\\n' >> "$FIXTURE_CALLS"\nmkdir -p "$FIXTURE_OBJECTS/lib"\nprintf 'fixture atomics cxx\\n' > "$FIXTURE_OBJECTS/lib/libc++.a"\nprintf 'fixture atomics abi\\n' > "$FIXTURE_OBJECTS/lib/libc++abi.a"`);
  const invoke = (env: NodeJS.ProcessEnv = {}) => Bun.spawnSync(["bash", join(root, "jsc/build-libcxx.sh")], { env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, FIXTURE_PATCHES: join(root, "patches"), FIXTURE_CALLS: join(root, "calls"), FIXTURE_OBJECTS: join(libcxx, "build"), FIXTURE_CONFIG: config, ...env } });
  return { root, source, sdk, libcxx, invoke };
}
function withHarness(action: (h: Harness) => void): void {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-libcxx-inputs-"));
  try { action(prepare(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}
function build(h: Harness): void {
  const result = h.invoke();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}
test("libcxx cache verifies completion and reuses unchanged archives without rebuilding", () => withHarness(h => {
  build(h);
  const calls = readFileSync(join(h.root, "calls"), "utf8");
  build(h);
  expect(readFileSync(join(h.root, "calls"), "utf8")).toBe(calls);
  expect(existsSync(join(h.libcxx, ".bunwasm-inputs"))).toBe(true);
  expect(existsSync(join(h.libcxx, ".bunwasm-archives"))).toBe(true);
}));
const changes = [
  "sdk/bin/clang", "sdk/bin/clang++", "sdk/VERSION", "sdk/share/cmake/WASI.cmake", "sysroot/bun-wasm-sysroot.json", "sysroot/include/stdlib.h",
  "jsc/build-libcxx.sh", "jsc/common.sh", "bin/cmake", "libcxx/lib/libc++.a", "libcxx/lib/libc++abi.a", "libcxx/llvm-pr-186054.patch", "libcxx/llvm-project/libcxx/a.txt", "libcxx/llvm-project/untracked.h",
  "sdk/share/wasi-sysroot/include/wasm32-wasip1/noeh/c++/v1/__config_site", "libcxx/include/__config_site",
];
for (const path of changes) {
  test(`libcxx cache refuses changed ${path} without blessing or rebuilding it`, () => withHarness(h => {
    build(h);
    const calls = readFileSync(join(h.root, "calls"), "utf8");
    const stampPath = join(h.libcxx, ".bunwasm-inputs");
    const stamp = existsSync(stampPath) ? readFileSync(stampPath, "utf8") : undefined;
    const file = join(h.root, path);
    writeFileSync(file, (existsSync(file) ? readFileSync(file, "utf8") : "") + "\n# changed fixture input\n");
    expect(h.invoke().exitCode).not.toBe(0);
    expect(readFileSync(join(h.root, "calls"), "utf8")).toBe(calls);
    expect(existsSync(stampPath) ? readFileSync(stampPath, "utf8") : undefined).toBe(stamp);
  }));
}
test("libcxx cache refuses archives without completion even with an invalid SDK", () => withHarness(h => {
  mkdirSync(join(h.libcxx, "lib"));
  writeFileSync(join(h.libcxx, "lib/libc++.a"), "old cxx\n");
  writeFileSync(join(h.libcxx, "lib/libc++abi.a"), "old abi\n");
  rmSync(h.sdk, { recursive: true });
  expect(h.invoke().exitCode).not.toBe(0);
  expect(existsSync(join(h.root, "calls"))).toBe(false);
}));
test("libcxx resumes an interrupted patch sequence and verifies the complete pinned source", () => withHarness(h => {
  fixtureGit(h.source, "apply", join(h.root, "patches/llvm-pr-186054.patch"));
  build(h);
  expect(readFileSync(join(h.source, "libcxx/a.txt"), "utf8")).toBe("after\n");
  expect(readFileSync(join(h.source, "libcxxabi/b.txt"), "utf8")).toBe("after\n");
  build(h);
}));
test("libcxx completion refuses a missing ABI header and a partially removed archive", () => withHarness(h => {
  build(h);
  const calls = readFileSync(join(h.root, "calls"), "utf8");
  rmSync(join(h.sdk, "share/wasi-sysroot/include/wasm32-wasip1/noeh/c++/v1/__config_site"));
  expect(h.invoke().exitCode).not.toBe(0);
  expect(readFileSync(join(h.root, "calls"), "utf8")).toBe(calls);
  writeFileSync(join(h.sdk, "share/wasi-sysroot/include/wasm32-wasip1/noeh/c++/v1/__config_site"), "fixture ABI\n");
  rmSync(join(h.libcxx, "lib/libc++abi.a"));
  expect(h.invoke().exitCode).not.toBe(0);
  expect(readFileSync(join(h.root, "calls"), "utf8")).toBe(calls);
}));

test("libcxx completion cannot omit an archive from its byte manifest", () => withHarness(h => {
  build(h);
  const calls = readFileSync(join(h.root, "calls"), "utf8");
  const manifest = join(h.libcxx, ".bunwasm-archives");
  writeFileSync(manifest, readFileSync(manifest, "utf8").split("\n")[0] + "\n");
  writeFileSync(join(h.libcxx, "lib/libc++abi.a"), "changed unlisted archive\n");
  expect(h.invoke().exitCode).not.toBe(0);
  expect(readFileSync(join(h.root, "calls"), "utf8")).toBe(calls);
}));

test("libcxx source validation does not fetch excluded blobs from its sparse clone", () => withHarness(h => {
  mkdirSync(join(h.source, "unrelated"));
  writeFileSync(join(h.source, "unrelated/not-built.txt"), "outside the runtime build\n");
  fixtureGit(h.source, "add", ".");
  fixtureGit(h.source, "commit", "-m", "unrelated source");
  const pin = fixtureGit(h.source, "rev-parse", "HEAD");
  fixtureGit(h.source, "config", "uploadpack.allowfilter", "true");
  const origin = join(h.libcxx, "origin");
  renameSync(h.source, origin);
  const clone = Bun.spawnSync(["git", "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${origin}`, h.source]);
  expect(clone.exitCode, clone.stderr.toString()).toBe(0);
  fixtureGit(h.source, "sparse-checkout", "set", "runtimes", "libcxx", "libcxxabi");
  fixtureGit(h.source, "checkout", "-q", "--detach", pin);
  fixtureGit(h.source, "remote", "set-url", "origin", `file://${h.root}/missing-origin`);
  const path = join(h.root, "jsc/build-libcxx.sh");
  writeFileSync(path, readFileSync(path, "utf8").replace(/^llvm_commit=[a-f0-9]{40}$/m, `llvm_commit=${pin}`));
  const absent = () => Bun.spawnSync(["git", "-C", h.source, "cat-file", "-e", "HEAD:unrelated/not-built.txt"], { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } }).exitCode !== 0;
  expect(absent()).toBe(true);
  const first = h.invoke({ GIT_NO_LAZY_FETCH: "1" });
  expect(first.exitCode, first.stderr.toString()).toBe(0);
  expect(absent()).toBe(true);
  const warm = h.invoke({ GIT_NO_LAZY_FETCH: "1" });
  expect(warm.exitCode, warm.stderr.toString()).toBe(0);
  expect(absent()).toBe(true);
}));

test("libcxx verifies SDK patches that update the same file in sequence", () => withHarness(h => {
  writeFileSync(join(h.root, "patches/llvm-undo-part-of-194317.patch"), "diff --git a/libcxx/a.txt b/libcxx/a.txt\n--- a/libcxx/a.txt\n+++ b/libcxx/a.txt\n@@ -1 +1 @@\n-after\n+twice\n");
  build(h);
  expect(readFileSync(join(h.source, "libcxx/a.txt"), "utf8")).toBe("twice\n");
  build(h);
}));
