#[path = "../../crates/bunwasm-runtime/src/esbuild_packet.rs"]
mod esbuild_packet;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let source = std::fs::read_to_string(&args[1]).unwrap();
    let adapted = esbuild_packet::adapt(&source, &args[1]);
    std::fs::write(&args[2], adapted.as_bytes()).unwrap();
}
