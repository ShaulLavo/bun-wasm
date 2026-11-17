#[path = "../bunwasm-runtime/build/engine_pin.rs"]
mod engine_pin;
#[path = "../bunwasm-runtime/build/program_profile.rs"]
mod program_profile;
#[path = "../bunwasm-engine-quickjs/build/transfer_fault.rs"]
mod transfer_fault;

/// The commit `spidermonkey/common.sh` pins and the milestone (`config/milestone.txt`) at it.
const PINNED: (&str, &str) = ("a5df22d986d4b626f771b4f8885241941601c35c", "161.0a1");

fn main() {
    program_profile::configure();
    // A validation side, never a release: `../bunwasm-engine-quickjs/src/transfer_fault.rs`.
    transfer_fault::configure();
    let commit = engine_pin::read("spidermonkey/common.sh", "SPIDERMONKEY_COMMIT");
    assert_eq!(
        commit, PINNED.0,
        "spidermonkey/common.sh moved: update PINNED to the new commit's config/milestone.txt"
    );
    println!("cargo:rustc-env=BUN_WASM_SPIDERMONKEY_VERSION={}", PINNED.1);
}
