// Register the native lint ABI used by the linked upstream drivers.
use bunwasm_lint_native as _;

extern crate bunwasm_posix;
mod check_command;
#[path = "../../bunwasm-runtime/src/host.rs"]
#[allow(dead_code)] // Shared ABI module; this binary uses only tool slots.
mod host;
mod lint_command;
#[path = "../../bunwasm-cli/src/tool_args.rs"]
mod tool_args;
#[path = "../../../vendor/bun/src/runtime/cli/typescript_libs.rs"]
mod typescript_libs;

#[used]
static KEEP_HOST_SLOTS: extern "C" fn() -> *mut host::HostSlots = host::bun_wasm_host_slots;

fn main() {
    bunwasm_glue::init();
    if let Ok(pwd) = std::env::var("PWD") {
        let _ = std::env::set_current_dir(&pwd);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((command, forwarded, globals)) = tool_args::before_command(&args) else {
        eprintln!("error: bun-tools supports bun lint, bun fmt and bun check");
        std::process::exit(2);
    };
    if command == "check" {
        let code = check_command::run(
            &forwarded,
            typescript_libs::BUNDLED,
            globals.cwd_before.as_deref(),
        );
        std::process::exit(code);
    }
    std::process::exit(lint_command::run(&command, forwarded, globals));
}
