import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function executable(path: string, source: string) {
  await writeFile(path, `#!/bin/sh\nset -eu\n${source}\n`);
  await chmod(path, 0o700);
}

async function producer(fetchStatus: number) {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-quickjs-producer-"));
  try {
    const bin = join(root, "bin");
    const sysroot = join(root, "selected-toolchain");
    const trace = join(root, "trace");
    await mkdir(bin);
    await mkdir(join(root, "scripts"));
    await copyFile(new URL("../../scripts/build-engine-quickjs.sh", import.meta.url), join(root, "scripts/build-engine-quickjs.sh"));
    await writeFile(join(root, "env.sh"), `export PATH=${JSON.stringify(bin)}:$PATH\nexport BUN_WASM_SYSROOT=${JSON.stringify(join(root, "libc"))}\n`);
    await executable(join(bin, "rustc"), 'printf "compiler %s\\n" "$*" >> "$TRACE"\nprintf "%s\\n" "$SELECTED_SYSROOT"');
    await executable(join(bin, "cargo"), `printf 'cargo %s\\n' "$*" >> "$TRACE"
if [ "$1" = fetch ]; then
  [ "$FETCH_STATUS" = 0 ] || exit "$FETCH_STATUS"
  touch "$PREPARED"
  exit 0
fi
[ -f "$PREPARED" ] || { printf 'missing cold std dependency\\n' >&2; exit 101; }`);
    for (const name of ["clang", "wasm-ld", "node", "wasm-tools"]) await executable(join(bin, name), `printf '${name} %s\\n' "$*" >> "$TRACE"`);
    const result = Bun.spawnSync(["bash", join(root, "scripts/build-engine-quickjs.sh")], {
      env: { ...process.env, QUICKJS_BUILD_DIR: join(root, "out"), CARGO_BUILD_JOBS: "2", RUSTC: join(bin, "rustc"), TRACE: trace, SELECTED_SYSROOT: sysroot, PREPARED: join(root, "prepared"), FETCH_STATUS: String(fetchStatus) },
      stdin: "ignore",
    });
    return { exitCode: result.exitCode, stderr: result.stderr.toString(), calls: (await readFile(trace, "utf8")).trim().split("\n"), sysroot };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("QuickJS producer prepares the selected compiler's locked std before the offline PIC build", async () => {
  const result = await producer(0);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.calls.slice(0, 3)).toEqual([
    "compiler --print sysroot",
    `cargo fetch --locked --manifest-path ${result.sysroot}/lib/rustlib/src/rust/library/Cargo.toml --target wasm32-wasip1`,
    "cargo build --locked --offline -Zbuild-std=std,panic_abort --release --target wasm32-wasip1 -j 2 -p bunwasm-engine-quickjs",
  ]);
  expect(result.calls.slice(3).map(call => call.split(" ")[0])).toEqual(["clang", "wasm-ld", "node", "wasm-tools"]);
  expect(result.calls.at(-1)).toContain("wasm-tools validate ");
});

test("failed pinned std preparation stops before compilation, linking or validation", async () => {
  const result = await producer(23);
  expect(result.exitCode).toBe(23);
  expect(result.calls).toEqual([
    "compiler --print sysroot",
    `cargo fetch --locked --manifest-path ${result.sysroot}/lib/rustlib/src/rust/library/Cargo.toml --target wasm32-wasip1`,
  ]);
});
