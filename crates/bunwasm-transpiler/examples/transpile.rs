//! `transpile [--map|--register] <file>`: print Bun's transpiled output for
//! one file (with `--map`, the v3 source map JSON instead; with `--register`,
//! the module's registration record for engines without native ES modules).
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let map = args.iter().any(|a| a == "--map");
    let register = args.iter().any(|a| a == "--register");
    let path = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .expect("usage: transpile [--map|--register] <file>");
    let source = std::fs::read_to_string(path).expect("read input");
    let loader =
        bunwasm_transpiler::Loader::from_path(path).unwrap_or(bunwasm_transpiler::Loader::Ts);
    let result = if register {
        bunwasm_transpiler::register(&source, path, loader).map(|t| {
            if map {
                bunwasm_transpiler::source_map_json(path, &source, &t.mappings)
            } else {
                t.code
            }
        })
    } else if map {
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
