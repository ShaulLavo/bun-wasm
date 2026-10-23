import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { guestBuilds, hash, type GuestBuild, type SourceOptions } from "../../scripts/guest-source-manifest.ts";
import type { GuestBuildReceipt } from "../../scripts/guest-build-receipt.ts";

export const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
export function fixtureReceipt(bytes: Uint8Array, build: GuestBuild): GuestBuildReceipt {
  const groupNames = ["repository", "bun", "waffle-libc", "sysroot", "sdk", "rust-target", "boringssl", "jsc-prebuild"];
  const sourceManifest = {
    schema: 1, build, source: { head: "d".repeat(40), tree: "e".repeat(40) },
    groups: groupNames.map(name => ({ name, files: [{ path: name === "sysroot" ? "bun-wasm-sysroot.json" : "fixture.txt", sha256: hash("fixture"), bytes: 7 }] })),
    tools: ["rustc", "cargo", "bun", "clang", "clang++", "llvm-ar", "wasm-ld", "cmake", "ninja", "wasm-opt"].map(name => ({ name, path: `/fixture/${name}`, sha256: hash(name), version: "fixture only" })),
    omissions: ["Synthetic receipt for tiny utility tests, not build or publication evidence."],
  } satisfies GuestBuildReceipt["sourceManifest"];
  return { bunHead: "a".repeat(40), bunTree: "b".repeat(40), sysrootReceiptSha256: hash("fixture"), sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)), artifactSha256: hash(bytes), artifactBytes: bytes.byteLength };
}

export function fixtureGit(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root].concat(args), { stdin: "ignore" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function put(root: string, path: string, text = "fixture\n") {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

function init(root: string) {
  fixtureGit(root, "init", "-b", "fixture");
  fixtureGit(root, "config", "user.name", "Guest receipt fixture");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
}

export async function withReceiptFixture(run: (options: SourceOptions, artifact: string) => Promise<void>) {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-guest-receipt-"));
  try {
    const vendor = join(root, "vendor/bun");
    await mkdir(vendor, { recursive: true });
    init(vendor);
    await put(vendor, ".gitignore", "build/\nvendor/\n");
    for (const path of ["src/input.rs", "Cargo.toml", "Cargo.lock", "build/debug/codegen/build_options.rs", "vendor/lolhtml/src/lib.rs", "vendor/rust-argon2/src/lib.rs"]) await put(vendor, path);
    fixtureGit(vendor, "add", ".");
    fixtureGit(vendor, "commit", "-m", "pinned imported source");
    const script = await readFile(new URL("../../scripts/sync-bun.sh", import.meta.url), "utf8");
    await put(root, "scripts/sync-bun.sh", script.replace(/^BUN_COMMIT=.*$/m, `BUN_COMMIT=${fixtureGit(vendor, "rev-parse", "HEAD")}`));
    await put(root, "env.sh", `export TMPDIR=${JSON.stringify(root)}\n`);
    await put(root, ".gitignore", "vendor/\nsysroot/\nsdk/\nwaffle/\nrustlib/\nfake-tool\ndist/\nprivate/\njsc-build/\n");
    await put(root, "crates/fixture/src/lib.rs");
    await put(root, "patches/bun/fixture.config");
    await put(root, "Cargo.lock");
    init(root);
    fixtureGit(root, "add", ".");
    fixtureGit(root, "commit", "-m", "pinned repository source");
    for (const path of ["sysroot/bun-wasm-sysroot.json", "sysroot/include/stdio.h", "sysroot/lib/wasm32-wasip1/libc.a", "sdk/VERSION", "sdk/lib/clang/builtins.a", "rustlib/libstd.rlib", "waffle/package.json", "waffle/scripts/build-wasi-libc.sh", "waffle/patches/wasi-libc/preopen-scan.patch", "private/secret.txt"]) await put(root, path);
    await put(root, "sysroot/bun-wasm-sysroot.json", JSON.stringify({ builderSha256: hash("fixture\n"), patchSha256: hash("fixture\n"), libcSha256: hash("fixture\n"), sdkVersion: "fixture\n" }));
    for (const path of ["CMakeLists.txt", "cmake/input.cmake", "include/openssl/evp.h", "crypto/input.c", "gen/sources.cmake", "third_party/input.h", "util/input.c"]) await put(root, `vendor/boringssl/${path}`);
    await put(root, "fake-tool", "#!/bin/sh\nprintf 'fixture tool 1\\n'\n");
    await chmod(join(root, "fake-tool"), 0o700);
    for (const path of ["build/jsc/.bunwasm-inputs", "build/jsc/compile_commands.json", "inputs/wasi-jsc.cmake", "inputs/shim/wasi-compat.h", "build/jsc/lib/libJavaScriptCore.a", "build/jsc/lib/libWTF.a", "build/jsc/lib/libbmalloc.a", "icu/prefix/lib/libicuuc.a", "icu/prefix/lib/libicui18n.a", "icu/prefix/lib/libicudata.a", "shim/libwasi-compat.a"]) await put(root, `jsc-build/${path}`);
    const artifact = join(root, "dist", guestBuilds.browser.artifact);
    await put(root, "dist/bun-browser.wasm", "");
    await writeFile(artifact, wasm);
    const tools = Object.fromEntries(["rustc", "cargo", "bun", "clang", "clang++", "llvm-ar", "wasm-ld", "cmake", "ninja", "wasm-opt"].map(name => [name, join(root, "fake-tool")]));
    await run({ repository: root, sysroot: join(root, "sysroot"), sdk: join(root, "sdk"), waffle: join(root, "waffle"), boringssl: join(root, "vendor/boringssl"), rustTargetLib: join(root, "rustlib"), tools, build: "browser", jscBuild: join(root, "jsc-build") }, artifact);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
