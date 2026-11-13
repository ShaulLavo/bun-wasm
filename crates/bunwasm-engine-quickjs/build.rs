#[path = "../bunwasm-runtime/build/program_profile.rs"]
mod program_profile;
#[path = "build/transfer_fault.rs"]
mod transfer_fault;

fn main() {
    program_profile::configure();
    // A validation side, never a release: `src/transfer_fault.rs`.
    println!("cargo:rustc-check-cfg=cfg(bun_wasm_transfer_fault)");
    println!("cargo:rerun-if-env-changed=BUN_WASM_TRANSFER_FAULT");
    let ambient = std::env::var_os("BUN_WASM_TRANSFER_FAULT");
    let value = ambient
        .as_ref()
        .map(|value| value.to_str().unwrap_or("not UTF-8"));
    match transfer_fault::selected(value) {
        Ok(true) => println!("cargo:rustc-cfg=bun_wasm_transfer_fault"),
        Ok(false) => {}
        Err(refusal) => panic!("{refusal}"),
    }
}
