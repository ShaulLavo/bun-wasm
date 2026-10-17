# Source me: toolchain environment for bun-wasm (everything lives on /work).
export RUSTUP_HOME=/work/cache/rustup
export CARGO_HOME=/work/cache/cargo
export WASM_TOOLS=/work/cache/wasm-tools
export WASI_SDK_PATH=$WASM_TOOLS/wasi-sdk
export PATH=$WASM_TOOLS/cmake/bin:$WASM_TOOLS/ninja:$CARGO_HOME/bin:$WASM_TOOLS/wasmtime:$WASM_TOOLS/binaryen/bin:$WASM_TOOLS/wasm-tools-bin:$WASI_SDK_PATH/bin:$PATH
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/work/tmp/bun-wasm-target}
export CC_wasm32_wasip1=$WASI_SDK_PATH/bin/clang
export CXX_wasm32_wasip1=$WASI_SDK_PATH/bin/clang++
export AR_wasm32_wasip1=$WASI_SDK_PATH/bin/llvm-ar
export CFLAGS_wasm32_wasip1="--sysroot=$WASI_SDK_PATH/share/wasi-sysroot"
export CXXFLAGS_wasm32_wasip1="--sysroot=$WASI_SDK_PATH/share/wasi-sysroot"
# Reuse this host's installed browser cache without downloading. Other hosts keep
# Playwright's native cache; every explicit override (including empty or 0) wins.
if [ "${PLAYWRIGHT_BROWSERS_PATH+x}" != x ] && [ -d /work/cache/ms-playwright ]; then
  export PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright
fi
# Bun denies warnings workspace-wide; wasi cfg gaps leave unused items behind.
export CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="--cap-lints=warn -C link-self-contained=no"
