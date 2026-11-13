#[path = "../../crates/bunwasm-runtime/src/oxc_memory.rs"]
mod oxc_memory;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let source = std::fs::read_to_string(&args[1]).unwrap();
    let started = std::time::Instant::now();
    let adapted = oxc_memory::adapt(&source, &args[1]);
    let elapsed = started.elapsed().as_nanos();
    std::fs::write(&args[2], adapted.as_bytes()).unwrap();
    println!(
        "{{\"changed\":{},\"sourceBytes\":{},\"outputBytes\":{},\"nanoseconds\":{}}}",
        source != adapted,
        source.len(),
        adapted.len(),
        elapsed
    );
}
