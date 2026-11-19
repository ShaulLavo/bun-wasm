#[path = "../bunwasm-runtime/build/engine_pin.rs"]
mod engine_pin;

fn main() {
    let commit = engine_pin::read("hermes/common.sh", "HERMES_COMMIT");
    println!("cargo:rustc-env=BUN_WASM_HERMES_COMMIT={commit}");
}
