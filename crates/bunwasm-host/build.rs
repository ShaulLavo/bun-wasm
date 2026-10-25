use std::{env, fs, path::Path};

use sha2::{Digest, Sha256};

const INPUT: &str = "51b8d72bc523499e3dadde0fa73da7f6162073f7807f3c62680462c4fffbb84b";
const CHECKSUM: &str = "96ead65db78b3774198b4feb771a35f754b2e1be052a8c4b9ad414bc41dfd88e";

fn main() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("network");
    for name in ["network.wasm", "network.input-hash", "network.sha256"] {
        println!("cargo:rerun-if-changed={}", source.join(name).display());
    }
    let bytes =
        fs::read(source.join("network.wasm")).expect("missing staged Waffle38bc network module");
    assert_eq!(bytes.len(), 89_877, "unexpected Waffle network module size");
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        CHECKSUM,
        "unexpected Waffle network module bytes"
    );
    assert_eq!(
        fs::read_to_string(source.join("network.sha256"))
            .unwrap()
            .trim(),
        CHECKSUM
    );
    assert_eq!(
        fs::read_to_string(source.join("network.input-hash"))
            .unwrap()
            .trim(),
        INPUT
    );
    let output = Path::new(&env::var_os("OUT_DIR").unwrap()).join("waffle-network");
    fs::create_dir_all(&output).unwrap();
    fs::write(output.join("network.wasm"), bytes).unwrap();
    fs::write(output.join("network.sha256"), CHECKSUM).unwrap();
    fs::write(output.join("network.input-hash"), INPUT).unwrap();
    println!(
        "cargo:rustc-env=BUN_WAFFLE_NETWORK_MODULE={}",
        output.join("network.wasm").display()
    );
}
