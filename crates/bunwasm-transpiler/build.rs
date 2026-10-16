fn main() {
    println!("cargo:rerun-if-env-changed=WASI_SDK_PATH");
    if std::env::var("TARGET").unwrap() != "wasm32-wasip1" {
        return;
    }
    let sdk = std::env::var("WASI_SDK_PATH").expect("WASI_SDK_PATH (source env.sh)");
    println!(
        "cargo:rustc-link-arg-examples={sdk}/share/wasi-sysroot/lib/wasm32-wasip1/crt1-command.o"
    );
}
