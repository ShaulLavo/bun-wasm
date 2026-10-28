import { expect, test } from "bun:test";
import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseProgramReceipt, record } from "../../scripts/guest-core-receipt.ts";
import { hash } from "../../scripts/guest-source-manifest.ts";
import { fixtureGit, withCliReceiptFixture } from "./guest-receipt-fixture.ts";
import { quickjsPair } from "./quickjs-plan-fixture.ts";

async function executable(path: string, source: string) {
  await writeFile(path, `#!/bin/sh\nset -eu\n${source}\n`);
  await chmod(path, 0o700);
}

async function producer(fetchStatus: number) {
  return withCliReceiptFixture(async fixture => {
    const { root } = fixture;
    const bin = join(root, "sdk/bin");
    const sysroot = join(root, "private/toolchain");
    const trace = join(root, "private/trace");
    await writeFile(trace, "");
    await copyFile(new URL("../../scripts/build-engine-quickjs.sh", import.meta.url), join(root, "scripts/build-engine-quickjs.sh"));
    await writeFile(join(root, "env.sh"), 'export CC_wasm32_wasip1="$WASI_SDK_PATH/bin/clang"\n');
    await writeFile(join(root, "private/quickjs.wasm"), quickjsPair().side);
    await executable(fixture.rustc, 'printf "compiler %s\\n" "$*" >> "$TRACE"\n' + (await readFile(fixture.rustc, "utf8")).replace(/^#![^\n]*\n/, "").replace('case "$2"', 'case "${2:-}"'));
    await executable(join(root, "fake-tool"), `
case "$1" in
  --version|-Vv) echo 'fixture tool 1'; exit 0;;
  fetch)
    printf 'cargo %s\\n' "$*" >> "$TRACE"
    [ "$FETCH_STATUS" = 0 ] || exit "$FETCH_STATUS"
    touch "$PREPARED"; exit 0;;
  build)
    printf 'cargo %s\\n' "$*" >> "$TRACE"
    [ -f "$PREPARED" ] || { printf 'missing cold std dependency\\n' >&2; exit 101; }
    printf 'flags %s|%s\\n' "$CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS" "$CFLAGS_wasm32_wasip1" >> "$TRACE"
    exit 0;;
esac
printf '%s %s\\n' "\${0##*/}" "$*" >> "$TRACE"
while [ "$1" != -o ]; do shift; done
printf 'captured fixture compiler output\\n' > "$2"
`);
    await executable(fixture.node, `
if [ "$1" = -p ]; then echo '${fixture.node}'; exit 0; fi
if [ "$1" = --version ]; then echo 'fixture node 1'; exit 0; fi
printf 'node %s\\n' "$*" >> "$TRACE"
cp private/quickjs.wasm "$4"
`);
    const validator = await readFile(join(bin, "wasm-tools"), "utf8");
    await executable(join(bin, "wasm-tools"), 'printf "wasm-tools %s\\n" "$*" >> "$TRACE"\n' + validator.replace(/^#![^\n]*\n/, ""));
    fixtureGit(root, "add", "scripts", "env.sh");
    fixtureGit(root, "commit", "-m", "captured QuickJS producer with real receipt CLIs");
    const output = join(root, "private/out");
    const result = Bun.spawnSync(["bash", join(root, "scripts/build-engine-quickjs.sh")], {
      cwd: root, env: { ...fixture.env, QUICKJS_BUILD_DIR: output, QUICKJS_SMOKE_EXPORTS: "0", CARGO_BUILD_JOBS: "2", TRACE: trace, PREPARED: join(root, "private/prepared"), FETCH_STATUS: String(fetchStatus) }, stdin: "ignore",
    });
    const calls = (await readFile(trace, "utf8")).trim().split("\n");
    const receiptPath = `${output}/engine.wasm.engine.json`;
    const receipt = await Bun.file(receiptPath).exists() ? parseProgramReceipt(await Bun.file(receiptPath).json()) : undefined;
    const identities = await Promise.all(([ ["rustc", fixture.rustc], ["cargo", join(root, "fake-tool")], ["node", fixture.node] ] as const).map(async ([name, path]) => ({ name, path, sha256: hash(await readFile(path)) })));
    return { exitCode: result.exitCode, stderr: result.stderr.toString(), calls, sysroot, receipt, identities, libc: fixture.env.BUN_WASM_SYSROOT };
  });
}

function producerCommands(calls: readonly string[]): string[] {
  return calls.filter(call => ["cargo fetch ", "cargo build ", "clang --target=", "wasm-ld --shared ", "node ", "wasm-tools validate "].some(prefix => call.startsWith(prefix)));
}

test("QuickJS producer prepares the selected compiler's locked std before the offline PIC build", async () => {
  const result = await producer(0);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const calls = producerCommands(result.calls);
  const fetch = `cargo fetch --locked --offline --manifest-path ${result.sysroot}/lib/rustlib/src/rust/library/Cargo.toml --target wasm32-wasip1`;
  expect(result.calls[result.calls.indexOf(fetch) - 1]).toBe("compiler --print sysroot");
  expect(calls.slice(0, 2)).toEqual([fetch, "cargo build --locked --offline -Zbuild-std=std,panic_abort --release --target wasm32-wasip1 -j 2 -p bunwasm-engine-quickjs"]);
  expect(calls.slice(2).map(call => call.split(" ")[0])).toEqual(["clang", "wasm-ld", "node", "wasm-tools"]);
  expect(result.calls).toContain(`flags -C relocation-model=pic -C panic=abort -C link-self-contained=no|--sysroot=${result.libc} -fPIC`);
  expect(calls.at(-1)).toContain("wasm-tools validate ");
  if (!result.receipt || !record(result.receipt.inputs.content)) throw new Error("Missing real engine receipt");
  expect(result.receipt.inputs.scope).toBe("quickjs");
  expect(result.receipt.inputs.content.tools).toEqual(expect.arrayContaining(result.identities.map(identity => expect.objectContaining(identity))));
});

test("failed pinned std preparation stops before compilation, linking or validation", async () => {
  const result = await producer(23);
  expect(result.exitCode, result.stderr).toBe(23);
  const fetch = `cargo fetch --locked --offline --manifest-path ${result.sysroot}/lib/rustlib/src/rust/library/Cargo.toml --target wasm32-wasip1`;
  expect(result.calls[result.calls.indexOf(fetch) - 1]).toBe("compiler --print sysroot");
  expect(producerCommands(result.calls)).toEqual([fetch]);
  expect(result.receipt).toBeUndefined();
});
