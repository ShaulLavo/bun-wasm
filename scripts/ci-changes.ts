import { execFileSync, spawnSync } from "node:child_process";
import { discoverChecks } from "./test-checks";

const nativeDirectories = ["crates/", "vendor/", "third_party/", "patches/", ".cargo/", "tests/fixtures/node-misc/", "tests/fixtures/source-cache/", "tests/fixtures/webassembly/", "tests/wasm-tables/", "tests/install/", "web/guest-tests/"];
const nativeFiles = new Set([
  "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "env.sh", "package.json", "bun.lock", ".github/workflows/ci.yml",
  "scripts/quality.ts", "scripts/quality-rust.ts", "scripts/quality-wasi.ts", "scripts/quality-wasi-probe.ts", "scripts/quality-command.ts", "scripts/quality-input-times.ts",
  "jsc/wasi-jsc.cmake", "tests/fixtures/runtime-proc-spawn-requests.json", "scripts/test.sh",
  "scripts/check-cmake-cache.cmake", "scripts/check-wasi-cmake-cache.sh",
  "scripts/ci-changes.ts", "scripts/browser-build.ts", "scripts/guest-build-receipt.ts", "scripts/guest-source-manifest.ts", "scripts/transpile-runtime.ts",
  "scripts/check-quickjs-async-context.ts", "scripts/fixtures/quickjs-async-context.c", "scripts/fixtures/quickjs-async-context.ts",
]);
const nativeCheckDirectories = discoverChecks().filter(check => check.owner === "native").map(check => `${check.path}/`);
const nativeCheckManifests = /^checks\/(?:native|runtime)-[a-z0-9-]+\.json$/;
const nativeScripts = /^scripts\/(?:build[.-]|sync-|export-patches|generate-)/;
const runtimeDeclaration = /^crates\/bunwasm-runtime\/src\/js\/.+\.d\.ts$/;

const jscDirectories = ["jsc/", "crates/bunwasm-jsc/", "crates/bunwasm-engine-jsc/", "tests/fixtures/shared-array-buffer/", "tests/fixtures/astro-http2-response/", "tests/jsc-embedding/"];
const jscFiles = new Set([
  "crates/bunwasm-engine-quickjs/src/program.rs", "crates/bunwasm-engine-quickjs/src/loader.rs", "crates/bunwasm-engine-quickjs/src/value_natives.rs",
  "crates/bunwasm-engine-quickjs/src/driver.rs", "crates/bunwasm-engine-quickjs/src/client.rs", "crates/bunwasm-engine-quickjs/src/natives.rs", "crates/bunwasm-engine-quickjs/src/allocator.rs", "crates/bunwasm-engine-quickjs/src/transport.rs",
  "crates/bunwasm-runtime/src/engine_jsc.rs", "scripts/build-bun-jsc.sh", "scripts/build-engine-jsc.sh", "scripts/build-engine-quickjs.sh", "scripts/build-bun-core.sh", "scripts/build.sh", "scripts/quickjs-core-exports.txt", "scripts/build-jsc.sh",
  "scripts/guest-artifact.ts", "scripts/guest-build-receipt.ts", "scripts/guest-core-receipt.ts", "scripts/guest-engine-receipt.ts", "scripts/guest-source-manifest.ts", "scripts/guest-acceptance.ts",
  "scripts/src/engine-explicit-init.ts", "scripts/src/engine-init.c", "scripts/engine-producer.test.ts", "scripts/src/engine-explicit-init.test.ts",
  "src/engine-kind.ts", "src/assets.ts", "src/quickjs-program.ts", "web/src/engine-loader.ts",
  "scripts/jsc-embedding.ts", "scripts/jsc-embedding.test.ts", "scripts/bench-jsc.sh", "scripts/ci-changes.ts", ".github/workflows/ci.yml",
  "env.sh", "scripts/build-wasi-sysroot.ts", "scripts/waffle-release-inputs.ts", "scripts/waffle-release-inputs.json", "scripts/ci-binaryen.ts", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "bun.lock",
]);

const webGuestDirectories = [
  "web/src/net/", "tests/fixtures/spawn-executable/", "tests/install/",
  "crates/bunwasm-runtime/", "crates/bunwasm-cli/", "crates/bunwasm-tools/", "crates/bunwasm-lint-native/",
  "crates/bunwasm-build/", "crates/bunwasm-transpiler/", "crates/bunwasm-glue/", "crates/bunwasm-posix/",
  "crates/bunwasm-semver/", "crates/bunwasm-crypto-sys/", "patches/", "third_party/", ".cargo/",
];
const webGuestFiles = new Set([
  "scripts/test-web-guests.ts", "scripts/test-web-guests.test.ts", "scripts/guest-build-receipt.ts",
  "scripts/build-bun-tools.sh", "scripts/transpile-runtime.ts", "scripts/sync-bun.sh", "scripts/sync-crypto.sh", "web/bun.lock",
  "tests/fixtures/runtime-proc-spawn-requests.json", "web/guest-tests/compose.ts", "web/guest-tests/jsc.test.ts",
  "web/tests/subprocess.ts", "web/tests/subprocess.mjs",
  "web/src/fs.ts", "web/src/tool-command.ts", "web/src/engine-host.js", "web/src/engine-host.d.ts",
  "web/src/crypto-host.js", "web/src/crypto-inputs.js", "web/src/promise-reactions.ts",
  "web/src/native-stream-state.ts", "web/src/native-direct-stream.ts", "web/src/buffer-transfer.ts", "web/src/content-modules.ts",
]);
const engineSpecificFiles = new Set([
  "crates/bunwasm-runtime/src/engine_quickjs.rs", "crates/bunwasm-runtime/src/engine_host.rs",
]);

function sharedWebGuestInput(path: string): boolean {
  if (runtimeDeclaration.test(path)) return false;
  if (engineSpecificFiles.has(path)) return false;
  return webGuestFiles.has(path) || path.startsWith("web/scripts/node-") || webGuestDirectories.some(root => path.startsWith(root));
}

function nativeInput(path: string): boolean {
  if (runtimeDeclaration.test(path)) return false;
  return path === "scripts/test-checks.ts" || nativeCheckManifests.test(path) || nativeCheckDirectories.some(root => path.startsWith(root))
    || path.startsWith("web/tests/bun-runtime-proc-") || nativeFiles.has(path) || nativeScripts.test(path)
    || nativeDirectories.some(root => path.startsWith(root));
}

export function needsJsc(paths: readonly string[]): boolean {
  return paths.some(path => sharedWebGuestInput(path) || jscFiles.has(path) || jscDirectories.some(root => path.startsWith(root)));
}

export function needsRust(paths: readonly string[]): boolean {
  return needsJsc(paths) || paths.some(nativeInput);
}

export function changedPaths(base: string, head: string, pullRequest: boolean): string[] {
  if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) throw new Error("Expected full base and head commit IDs");
  if (/^0+$/.test(base)) return ["Cargo.toml"];
  const range = pullRequest ? `${base}...${head}` : `${base}..${head}`;
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", range], { encoding: "utf8" }).split("\0").filter(Boolean);
}

function manifestInputs(ref: string): string | undefined {
  const result = spawnSync("git", ["show", `${ref}:package.json`], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const manifest: unknown = JSON.parse(result.stdout);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Invalid root package manifest");
  return JSON.stringify(Object.entries(manifest).filter(([key]) => key !== "version"));
}

function nativeChanges(paths: readonly string[], base: string, head: string): string[] {
  if (!paths.includes("package.json")) return paths.filter(path => needsRust([path]));
  const before = manifestInputs(base);
  const after = manifestInputs(head);
  return paths.filter(path => needsRust([path]) && (path !== "package.json" || before === undefined || after === undefined || before !== after));
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("Usage: ci-changes.ts <base-sha> <head-sha>");
  const paths = changedPaths(base, head, process.env.GITHUB_EVENT_NAME === "pull_request");
  const native = nativeChanges(paths, base, head);
  console.error(`Native inputs changed: ${native.join(", ") || "none"}`);
  console.log(`rust=${needsRust(native)}\njsc=${needsJsc(paths)}`);
}
