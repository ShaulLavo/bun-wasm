// Register the native lint ABI used by the linked upstream drivers.
use bunwasm_lint_native as _;

extern crate bunwasm_posix;
#[path = "../../bunwasm-runtime/src/host.rs"]
#[allow(dead_code)] // Shared ABI module; this binary uses only tool slots.
mod host;
mod lint_command;
#[path = "../../bunwasm-cli/src/tool_args.rs"]
mod tool_args;

#[used]
static KEEP_HOST_SLOTS: extern "C" fn() -> *mut host::HostSlots = host::bun_wasm_host_slots;

fn main() {
    bunwasm_glue::init();
    if let Ok(pwd) = std::env::var("PWD") {
        let _ = std::env::set_current_dir(&pwd);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(tool) = tool_args::before_command(&args) else {
        eprintln!("error: bun-tools supports bun lint and bun fmt");
        std::process::exit(2);
    };
    std::process::exit(lint_command::run(&tool.command, tool.args, tool.globals));
}
