# Source me: toolchain environment for bun-wasm (everything lives on /work).
export RUSTUP_HOME=${RUSTUP_HOME:-/work/cache/rustup}
export CARGO_HOME=${CARGO_HOME:-/work/cache/cargo}
export WASM_TOOLS=${WASM_TOOLS:-/work/cache/wasm-tools}
export WASI_SDK_PATH=${WASI_SDK_PATH:-$WASM_TOOLS/wasi-sdk}
_bunwasm_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# One consumer-owned libc, built by the exact installed Waffle builder. Never use
# the SDK/Rust libc as a fallback. The default path is keyed by the pinned libc
# builder and patch, so a new Waffle pin selects (or builds) its own sysroot; the
# receipt still rejects other changed inputs (SDK, tools, flags) at that path.
if [ -z "${BUN_WASM_SYSROOT:-}" ]; then
  _bunwasm_libc=$(grep -oE '"(scripts/build-wasi-libc\.sh|patches/wasi-libc/preopen-scan\.patch)": *"[0-9a-f]{64}"' "$_bunwasm_root/scripts/waffle-release-inputs.json" 2>/dev/null || true)
  if [ "$(printf '%s\n' "$_bunwasm_libc" | wc -l)" != 2 ]; then
    echo "env.sh: scripts/waffle-release-inputs.json must pin the Waffle libc builder and patch; set BUN_WASM_SYSROOT to choose a sysroot" >&2
    unset _bunwasm_root _bunwasm_libc
    return 1
  fi
  export BUN_WASM_SYSROOT=$WASM_TOOLS/bun-wasm-sysroot-$(printf '%s\n' "$_bunwasm_libc" | sha256sum | cut -c1-12)
fi
export PATH=$WASM_TOOLS/cmake/bin:$WASM_TOOLS/ninja:$CARGO_HOME/bin:$WASM_TOOLS/wasmtime:$WASM_TOOLS/binaryen/bin:$WASM_TOOLS/wasm-tools-bin:$WASI_SDK_PATH/bin:$PATH
# Each checkout keeps its own stable artifacts and Cargo lock.
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$_bunwasm_root/target}
unset _bunwasm_root _bunwasm_libc
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
