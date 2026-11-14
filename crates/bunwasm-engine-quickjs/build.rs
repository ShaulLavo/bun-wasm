#[path = "../bunwasm-runtime/build/program_profile.rs"]
mod program_profile;
#[path = "build/transfer_fault.rs"]
mod transfer_fault;

fn main() {
    program_profile::configure();
    // A validation side, never a release: `src/transfer_fault.rs`.
    transfer_fault::configure();
}
