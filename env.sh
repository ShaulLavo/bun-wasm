# Source me: toolchain environment for bun-wasm (everything lives on /work).
export RUSTUP_HOME=${RUSTUP_HOME:-/work/cache/rustup}
export CARGO_HOME=${CARGO_HOME:-/work/cache/cargo}
export WASM_TOOLS=${WASM_TOOLS:-/work/cache/wasm-tools}
export WASI_SDK_PATH=${WASI_SDK_PATH:-$WASM_TOOLS/wasi-sdk}
# One consumer-owned libc, built by the exact installed Waffle builder. Never use
# the SDK/Rust libc as a fallback. The receipt rejects changed build inputs.
export BUN_WASM_SYSROOT=${BUN_WASM_SYSROOT:-$WASM_TOOLS/bun-wasm-sysroot-waffle-afe9cc1f3f93}
export PATH=$WASM_TOOLS/cmake/bin:$WASM_TOOLS/ninja:$CARGO_HOME/bin:$WASM_TOOLS/wasmtime:$WASM_TOOLS/binaryen/bin:$WASM_TOOLS/wasm-tools-bin:$WASI_SDK_PATH/bin:$PATH
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/work/tmp/bun-wasm-target}
# This workstation's scratch policy belongs in its environment, not in consumers.
export TMPDIR=${TMPDIR:-/work/tmp}
export CC_wasm32_wasip1=$WASI_SDK_PATH/bin/clang
export CXX_wasm32_wasip1=$WASI_SDK_PATH/bin/clang++
export AR_wasm32_wasip1=$WASI_SDK_PATH/bin/llvm-ar
export CFLAGS_wasm32_wasip1="--sysroot=$BUN_WASM_SYSROOT"
export CXXFLAGS_wasm32_wasip1="--sysroot=$BUN_WASM_SYSROOT"
# Reuse this host's installed browser cache without downloading. Other hosts keep
# Playwright's native cache; every explicit override (including empty or 0) wins.
if [ "${PLAYWRIGHT_BROWSERS_PATH+x}" != x ] && [ -d /work/cache/ms-playwright ]; then
  export PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright
fi
# Bun denies warnings workspace-wide; wasi cfg gaps leave unused items behind.
export CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="--cap-lints=warn -C link-self-contained=no -L native=$BUN_WASM_SYSROOT/lib/wasm32-wasip1"
