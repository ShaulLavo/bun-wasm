#[path = "../bunwasm-runtime/build/program_profile.rs"]
mod program_profile;

fn main() {
    program_profile::configure();
    // A validation side, never a release: `src/transfer_fault.rs`.
    println!("cargo:rustc-check-cfg=cfg(bun_wasm_transfer_fault)");
    println!("cargo:rerun-if-env-changed=BUN_WASM_TRANSFER_FAULT");
    if std::env::var_os("BUN_WASM_TRANSFER_FAULT").is_some() {
        println!("cargo:rustc-cfg=bun_wasm_transfer_fault");
    }
}
