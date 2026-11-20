#[path = "../bunwasm-runtime/build/engine_pin.rs"]
mod engine_pin;
#[path = "../bunwasm-runtime/build/program_profile.rs"]
mod program_profile;
#[path = "../bunwasm-engine-quickjs/build/transfer_fault.rs"]
mod transfer_fault;

fn main() {
    program_profile::configure();
    // A validation side, never a release: `../bunwasm-engine-quickjs/src/transfer_fault.rs`.
    transfer_fault::configure();
    let commit = engine_pin::read("jsc/common.sh", "WEBKIT_COMMIT");
    println!("cargo:rustc-env=BUN_WASM_WEBKIT_COMMIT={commit}");
}
