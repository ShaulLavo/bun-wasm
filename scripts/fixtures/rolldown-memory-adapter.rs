#[path = "../../crates/bunwasm-runtime/src/rolldown_memory.rs"]
mod rolldown_memory;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let source = std::fs::read_to_string(&args[1]).unwrap();
    let adapted = rolldown_memory::adapt(&source, &args[1]);
    std::fs::write(&args[2], adapted.as_bytes()).unwrap();
    println!(
        "{{\"changed\":{},\"dependsOnBinary\":{}}}",
        source != adapted,
        rolldown_memory::depends_on_binary(&args[1])
    );
}
