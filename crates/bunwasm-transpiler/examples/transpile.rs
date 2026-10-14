//! `transpile <file>`: print Bun's transpiled output for one file.
fn main() {
    let path = std::env::args().nth(1).expect("usage: transpile <file>");
    let source = std::fs::read_to_string(&path).expect("read input");
    let loader = bunwasm_transpiler::Loader::from_path(&path).unwrap_or(bunwasm_transpiler::Loader::Ts);
    match bunwasm_transpiler::transpile(&source, &path, loader) {
        Ok(js) => print!("{js}"),
        Err(e) => {
            eprint!("{e}");
            std::process::exit(1);
        }
    }
}
