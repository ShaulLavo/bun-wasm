// Also builds directly with rustc, without compiling the Bun guest dependencies.
#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
#[path = "../instruction_count.rs"]
mod linux;

fn main() {
    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    std::process::exit(linux::main());
    #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
    {
        eprintln!("instruction-count requires 64-bit Linux");
        std::process::exit(2);
    }
}
