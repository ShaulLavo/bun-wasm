fn main() {
    println!("cargo:rerun-if-env-changed=BUN_WASM_SYSROOT");
    if std::env::var("TARGET").unwrap() != "wasm32-wasip1" {
        return;
    }
    let sysroot = std::env::var("BUN_WASM_SYSROOT").expect("BUN_WASM_SYSROOT (source env.sh)");
    println!("cargo:rustc-link-arg-examples={sysroot}/lib/wasm32-wasip1/crt1-command.o");
}
