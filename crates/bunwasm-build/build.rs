//! Link settings for bun-build.wasm.
fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.starts_with("wasm32") {
        return;
    }
    // Bun's parser recurses deeply: 8 MiB of stack.
    println!("cargo:rustc-link-arg-bin=bun-build=-zstack-size=8388608");
    // Bun's string pointer tags use the top three address bits on wasm32, so
    // linear memory must stay below 512 MiB.
    println!("cargo:rustc-link-arg-bin=bun-build=--max-memory=536870912");
    println!("cargo:rerun-if-env-changed=BUN_WASM_SYSROOT");
    if target == "wasm32-wasip1" {
        let sysroot = std::env::var("BUN_WASM_SYSROOT").expect("BUN_WASM_SYSROOT (source env.sh)");
        println!("cargo:rustc-link-arg-bin=bun-build={sysroot}/lib/wasm32-wasip1/crt1-command.o");
        println!("cargo:rustc-link-arg-examples={sysroot}/lib/wasm32-wasip1/crt1-command.o");
    }
}
