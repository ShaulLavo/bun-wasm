fn main() {
    println!("cargo:rerun-if-env-changed=BUN_WASM_SYSROOT");
    let package = "../../vendor/bun/package.json";
    println!("cargo:rerun-if-changed={package}");
    let text = std::fs::read_to_string(package).unwrap();
    let version = text
        .split_once("\"version\"")
        .unwrap()
        .1
        .split('"')
        .nth(1)
        .unwrap();
    println!("cargo:rustc-env=BUNWASM_BUN_VERSION={version}");
    if std::env::var("TARGET").unwrap() != "wasm32-wasip1" {
        return;
    }
    for flag in [
        "-zstack-size=8388608",
        "--max-memory=536870912",
        "--export-table",
        "--growable-table",
        "--export=bun_wasm_host_slots",
    ] {
        println!("cargo:rustc-link-arg-bin=bun-tools={flag}");
    }
    let sysroot = std::env::var("BUN_WASM_SYSROOT").expect("source env.sh");
    println!("cargo:rustc-link-arg-bin=bun-tools={sysroot}/lib/wasm32-wasip1/crt1-command.o");
}
