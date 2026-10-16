//! `transpile [--map] <file>`: print Bun's transpiled output for one file
//! (with `--map`, the v3 source map JSON instead).
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let map = args.iter().any(|a| a == "--map");
    let path = args.iter().find(|a| *a != "--map").expect("usage: transpile [--map] <file>");
    let source = std::fs::read_to_string(path).expect("read input");
    let loader = bunwasm_transpiler::Loader::from_path(path).unwrap_or(bunwasm_transpiler::Loader::Ts);
    let result = if map {
        bunwasm_transpiler::transpile_with_source_map(&source, path, loader, false)
            .map(|t| bunwasm_transpiler::source_map_json(path, &source, &t.mappings))
    } else {
        bunwasm_transpiler::transpile(&source, path, loader)
    };
    match result {
        Ok(out) => print!("{out}"),
        Err(e) => {
            eprint!("{e}");
            std::process::exit(1);
        }
    }
}
