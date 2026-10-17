//! Link settings for bun.wasm.
fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.starts_with("wasm32") {
        return;
    }
    // Bun's parser recurses deeply: 8 MiB of stack.
    println!("cargo:rustc-link-arg-bin=bun=-zstack-size=8388608");
    // Bun's string pointer tags use the top three address bits on wasm32, so
    // linear memory must stay below 512 MiB.
    println!("cargo:rustc-link-arg-bin=bun=--max-memory=536870912");
    // The bun_wasm host ABI (docs/host-abi.md): hosts install networking
    // functions into the exported, growable table and record their indices
    // in the slots `bun_wasm_host_slots` points at.
    println!("cargo:rustc-link-arg-bin=bun=--export-table");
    println!("cargo:rustc-link-arg-bin=bun=--growable-table");
    println!("cargo:rustc-link-arg-bin=bun=--export=bun_wasm_host_slots");
    // Host-engine build: the exports web/src/engine-host.js calls.
    if std::env::var_os("CARGO_FEATURE_ENGINE_HOST").is_some() {
        for name in ["bunwasm_ready", "bunwasm_alloc", "bunwasm_call", "bunwasm_describe", "bunwasm_result_ptr", "bunwasm_result_len"] {
            println!("cargo:rustc-link-arg-bin=bun=--export={name}");
        }
    }
    // BoringSSL and JavaScriptCore share wasi-sdk's libc with Rust.
    {
        let sdk = std::env::var("WASI_SDK_PATH").expect("WASI_SDK_PATH (source env.sh)");
        println!("cargo:rustc-link-arg-bin=bun={sdk}/share/wasi-sysroot/lib/wasm32-wasip1/crt1-command.o");
    }
}
