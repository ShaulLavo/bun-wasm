import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const recorder = `#!/usr/bin/env bash
set -euo pipefail
tool=\${0##*/}
printf '%s|%s|%s|%s|%s|%s\\n' "$tool" "$*" "\${CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS:-}" "\${CFLAGS_wasm32_wasip1:-}" "\${RUSTFLAGS:-}" "\${CARGO_ENCODED_RUSTFLAGS:-}" >> "$RECIPE_LOG"
case "$tool" in
  bun)
    script=\${1##*/}; shift
    command=\${1:-}; shift || true
    case "$script:$command" in
      guest-build-receipt.ts:environment)
        printf 'export GUEST_CARGO=%q RUSTC=%q\\n' "$RECIPE_BIN/selected-cargo" "$RECIPE_BIN/selected-rustc" ;;
      guest-core-receipt.ts:inputs|guest-engine-receipt.ts:inputs)
        [[ \${REJECT_INPUTS:-0} == 0 ]]
        echo '{"fixture":"command capture only"}' ;;
      guest-core-receipt.ts:verify|guest-engine-receipt.ts:verify) [[ \${REJECT_RECEIPT:-0} == 0 ]] ;;
      guest-core-receipt.ts:write) echo fixture > "$1.core.json" ;;
      guest-engine-receipt.ts:write) echo fixture > "$1.engine.json" ;;
      guest-core-receipt.ts:tag) cp "$1" "$3" ;;
      guest-engine-receipt.ts:environment)
        printf 'export CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS=%q CFLAGS_wasm32_wasip1=%q\\n' '-C relocation-model=pic -C panic=abort -C link-self-contained=no' "--sysroot=$BUN_WASM_SYSROOT -fPIC"
        if [[ $1 == jsc ]]; then printf 'export CXXFLAGS_wasm32_wasip1=%q\\n' "--sysroot=$BUN_WASM_SYSROOT -fPIC -fno-exceptions"; fi ;;
    esac ;;
  selected-cargo)
    if [[ $1 == tree ]]; then echo "\${RECIPE_DEPENDENCY:-bunwasm-cli v0.0.0}"; fi
    if [[ $1 == build ]]; then
      output="$CARGO_TARGET_DIR/wasm32-wasip1/release"
      mkdir -p "$output"
      printf fixture > "$output/bun.wasm"
      printf fixture > "$output/libbunwasm_engine_jsc.a"
      printf fixture > "$output/libbunwasm_engine_quickjs.a"
    fi ;;
  selected-rustc) printf '%s\\n' "$RECIPE_ROOT/rust" ;;
  cargo|rustc) echo 'unselected tool invoked' >&2; exit 96 ;;
  clang|clang++|wasm-ld|wasm-opt)
    while [[ $# -gt 0 && $1 != -o ]]; do shift; done
    [[ $# -ge 2 ]]
    printf 'recipe output, never executable wasm\\n' > "$2" ;;
  node) cp "\${@: -2:1}" "\${@: -1}" ;;
  wasm-tools|cmake) : ;;
  git) if [[ $1 == rev-parse ]]; then printf '%040d\\n' 0; fi ;;
  *) echo "unexpected recipe command: $tool" >&2; exit 97 ;;
esac
`;

function fixture(run: (root: string, shell: (script: string, env?: Record<string, string>, args?: string[]) => ReturnType<typeof Bun.spawnSync>, log: () => string) => void) {
  const root = mkdtempSync(join(tmpdir(), "producer-"));
  try {
    prepare(root);
    const bin = join(root, "sdk/bin");
    const logPath = join(root, "commands.log");
    const shell = (script: string, env: Record<string, string> = {}, args: string[] = []) => Bun.spawnSync(["bash", join(root, script)].concat(args), {
      cwd: root,
      env: { ...process.env, QUICKJS_SMOKE_EXPORTS: "0", ...env, RECIPE_ROOT: root, RECIPE_BIN: bin, RECIPE_LOG: logPath,
        PATH: `${bin}:/usr/bin:/bin`, CAGE: "", JSC_BUILD_DIR: join(root, "native"),
        JSC_ENGINE_BUILD_DIR: join(root, "side"), QUICKJS_BUILD_DIR: join(root, "quickjs"),
        BUN_CORE_BUILD_DIR: join(root, "core"), TMPDIR: join(root, "t") },
    });
    run(root, shell, () => readFileSync(logPath, "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function prepare(root: string): void {
  for (const directory of ["scripts/src", "jsc/shim", "sdk/bin", "t", "native/build/jsc/lib", "crates/bunwasm-cli"]) mkdirSync(join(root, directory), { recursive: true });
  for (const file of ["scripts/build.sh", "scripts/build-bun-jsc.sh", "scripts/build-bun-core.sh", "scripts/build-engine-jsc.sh", "scripts/build-engine-quickjs.sh", "jsc/configure.sh", "jsc/finalize.sh", "jsc/common.sh",
    "crates/bunwasm-cli/max-memory.txt"]) {
    copyFileSync(join(repository, file), join(root, file));
  }
  for (const tool of ["bun", "selected-cargo", "selected-rustc", "cargo", "rustc", "clang", "clang++", "wasm-ld", "wasm-opt", "wasm-tools", "node", "git", "cmake"]) {
    writeFileSync(join(root, "sdk/bin", tool), recorder, { mode: 0o755 });
  }
  writeFileSync(join(root, "env.sh"), 'export WASI_SDK_PATH="$RECIPE_ROOT/sdk" BUN_WASM_SYSROOT="$RECIPE_ROOT/sysroot"\nexport CC_wasm32_wasip1="$WASI_SDK_PATH/bin/clang"\nexport CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="ordinary-core-flags"\n');
  // Isolate native build inputs; only the actual shell recipes execute here.
  writeFileSync(join(root, "jsc/common.sh"), readFileSync(join(root, "jsc/common.sh"), "utf8") + '\ncheck_jsc_inputs_stamp() { printf "native-stamp-check\\n" >> "$RECIPE_LOG"; }\n');
  writeFileSync(join(root, "native/build/jsc/lib/libWTF.a"), "fixture BUN_WASM_STACK_KIB\n");
  writeFileSync(join(root, "native/build/jsc/lib/libJavaScriptCore.a"), "fixture archive\n");
  for (const file of ["sync-crypto.sh", "test-transpiler-example.sh"]) writeFileSync(join(root, "scripts", file), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(root, "scripts/check-wasi-cmake-cache.sh"), "#!/usr/bin/env bash\nexit 0\n");
  for (const file of ["wasi-jsc.cmake", "shim/wasi-compat.h", "shim/wasi-compat.c", "shim/madvise.c"]) writeFileSync(join(root, "jsc", file), "fixture input\n");
}

function success(result: ReturnType<typeof Bun.spawnSync>): void {
  expect(result.exitCode, result.stderr?.toString()).toBe(0);
}

test("pure core invokes selected Cargo once, optimizes once, and verifies reuse without any side command", () => {
  fixture((_root, shell, log) => {
    success(shell("scripts/build-bun-core.sh", { RUSTFLAGS: "ambient-override", CARGO_ENCODED_RUSTFLAGS: "encoded-override" }));
    success(shell("scripts/build-bun-core.sh"));
    const commands = log();
    expect(commands.match(/^selected-cargo\|build /gm)?.length).toBe(1);
    expect(commands.match(/^wasm-opt\|/gm)?.length).toBe(1);
    expect(commands).toContain("--no-default-features --features engine-split,bun-transpiler,bun-build");
    expect(commands).toContain("guest-core-receipt.ts verify");
    expect(commands).not.toContain("build-engine-");
    expect(commands).not.toContain("-Zbuild-std");
    expect(commands.split("\n").filter(line => line.startsWith("selected-cargo|")).join("\n")).not.toContain("override");
  });
});

test("input capture failures stop before compilation and release owned snapshot files", () => {
  fixture((root, shell, log) => {
    expect(shell("scripts/build-bun-core.sh", { REJECT_INPUTS: "1" }).exitCode).not.toBe(0);
    expect(shell("scripts/build-engine-jsc.sh", { REJECT_INPUTS: "1" }).exitCode).not.toBe(0);
    expect(log()).not.toContain("selected-cargo|");
    expect(readdirSync(join(root, "t"))).toEqual([]);
  });
});

test("core rejects a VM dependency before compilation and rejects incompatible reuse without fallback", () => {
  fixture((_root, shell, log) => {
    expect(shell("scripts/build-bun-core.sh", { RECIPE_DEPENDENCY: "└── bunwasm-jsc v0.0.0" }).exitCode).not.toBe(0);
    expect(log()).not.toContain("selected-cargo|build");
    success(shell("scripts/build-bun-core.sh"));
    expect(shell("scripts/build-bun-core.sh", { REJECT_RECEIPT: "1" }).exitCode).not.toBe(0);
    expect(log().match(/^selected-cargo\|build /gm)?.length).toBe(1);
  });
});

test("JSC side uses PIC build-std and spills the VM side before conversion; strict reuse skips all production", () => {
  fixture((root, shell, log) => {
    success(shell("scripts/build-engine-jsc.sh"));
    const first = log();
    expect(first).toContain("selected-cargo|fetch --locked --offline");
    expect(first).toContain("-Zbuild-std=std,panic_abort --release --target wasm32-wasip1");
    expect(first).toContain("-p bunwasm-engine-jsc|-C relocation-model=pic -C panic=abort -C link-self-contained=no");
    expect(first).toContain("-DENGINE_CTOR_VALUE=jsc_ctor_value");
    expect(first).toContain("--shared --Bsymbolic --no-export-dynamic --gc-sections --no-entry");
    expect(first).toContain("--export=jsc_register --export=jsc_run");
    expect(first).not.toContain("crt1");
    expect(first).not.toContain("-lc ");
    expect(first.indexOf("--spill-pointers")).toBeLessThan(first.indexOf("engine-explicit-init.ts jsc"));
    expect(first.indexOf("engine-explicit-init.ts jsc")).toBeLessThan(first.indexOf("guest-engine-receipt.ts write"));
    expect(readFileSync(join(root, "side/engine.wasm.engine.json"), "utf8")).toBe("fixture\n");
    success(shell("scripts/build-engine-jsc.sh"));
    expect(log().slice(first.length)).not.toMatch(/selected-cargo|wasm-ld|wasm-opt|engine-explicit-init/);
    expect(shell("scripts/build-engine-jsc.sh", { REJECT_RECEIPT: "1" }).exitCode).not.toBe(0);
    expect(log().match(/^selected-cargo\|build /gm)?.length).toBe(1);
  });
});

test("QuickJS keeps its initializer/export profile and invokes the selected compiler and shared fixture", () => {
  fixture((_root, shell, log) => {
    success(shell("scripts/build-engine-quickjs.sh"));
    expect(log()).toContain("-p bunwasm-engine-quickjs");
    expect(log()).toContain("-DENGINE_CTOR_VALUE=quickjs_ctor_value");
    expect(log()).toContain("--export=quickjs_register --export=quickjs_run");
    expect(log()).toContain("engine-explicit-init.ts quickjs");
    expect(log()).not.toContain("--spill-pointers");
  });
});

test("QuickJS smoke mode retains its alternate exports without writing a production engine receipt", () => {
  fixture((_root, shell, log) => {
    success(shell("scripts/build-engine-quickjs.sh", { QUICKJS_SMOKE_EXPORTS: "1" }));
    expect(log()).toContain("--export=quickjs_helpers_smoke");
    expect(log()).not.toContain("--export=quickjs_register");
    expect(log()).not.toContain("guest-engine-receipt.ts inputs");
    expect(log()).not.toContain("guest-engine-receipt.ts write");
  });
});

test("both wrappers compose one common compilation and stage each required side receipt", () => {
  fixture((root, shell, log) => {
    success(shell("scripts/build.sh"));
    success(shell("scripts/build-bun-jsc.sh"));
    const builds = log().split("\n").filter(line => line.startsWith("selected-cargo|build "));
    expect(builds.filter(line => line.includes("-p bunwasm-cli ")).length).toBe(1);
    expect(builds.filter(line => line.includes("-p bunwasm-engine-jsc|")).length).toBe(1);
    expect(builds.filter(line => line.includes("-p bunwasm-engine-quickjs|")).length).toBe(1);
    for (const side of ["quickjs.wasm", "jsc-engine.wasm"]) expect(readFileSync(join(root, "dist", `${side}.engine.json`), "utf8")).toBe("fixture\n");
    expect(log()).toContain("guest-core-receipt.ts tag");
  });
});

test("WebKit configure and each shim member request PIC without merging the shim members", () => {
  fixture((root, shell, log) => {
    // ar is captured independently: the recipe must preserve both named object members.
    const ar = join(root, "sdk/bin/llvm-ar");
    writeFileSync(ar, '#!/usr/bin/env bash\nprintf "archive|%s\\n" "$*" >> "$RECIPE_LOG"\nprintf fixture > "$2"\n', { mode: 0o755 });
    success(shell("jsc/configure.sh"));
    expect(log()).toContain("-DCMAKE_POSITION_INDEPENDENT_CODE=ON");
    const compiles = log().split("\n").filter(line => line.startsWith("clang|"));
    expect(compiles.length).toBe(2);
    for (const line of compiles) expect(line).toContain("-fPIC -O2 -c");
    expect(log()).toContain("wasi-compat.o");
    expect(log()).toContain("madvise.o");
  });
});
