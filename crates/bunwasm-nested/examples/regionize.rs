use std::{env, fs};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args_os().collect();
    if args.len() != 3 {
        return Err("usage: regionize input.wasm output.wasm".into());
    }
    let bytes = fs::read(&args[1])?;
    let output = bunwasm_nested::regionize(&bytes)?;
    fs::write(&args[2], &output.bytes)?;
    println!(
        "{} -> {} bytes; {:?}",
        bytes.len(),
        output.bytes.len(),
        output.memory
    );
    Ok(())
}
