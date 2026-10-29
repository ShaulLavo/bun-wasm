//! `transpile [--map] [--register] [--await-hooks] <file>`: print Bun's output.
//! `--map` prints the v3 source map; `--register` prints a module record.
//! `--await-hooks` uses the browser engine's async-context hooks.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let map = args.iter().any(|a| a == "--map");
    let hooks = args.iter().any(|a| a == "--await-hooks");
    let register = args.iter().any(|a| a == "--register");
    let path = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .expect("usage: transpile [--map] [--register] [--await-hooks] <file>");
    let source = std::fs::read_to_string(path).expect("read input");
    let loader =
        bunwasm_transpiler::Loader::from_path(path).unwrap_or(bunwasm_transpiler::Loader::Ts);
    let result = bunwasm_transpiler::with_await_hooks(hooks, || {
        if register {
            register_output(&source, path, loader, map)
        } else if map {
            bunwasm_transpiler::transpile_with_source_map(&source, path, loader, false)
                .map(|t| bunwasm_transpiler::source_map_json(path, &source, &t.mappings))
        } else {
            bunwasm_transpiler::transpile(&source, path, loader)
        }
    });
    match result {
        Ok(out) => print!("{out}"),
        Err(e) => {
            eprint!("{e}");
            std::process::exit(1);
        }
    }
}

fn register_output(
    source: &str,
    path: &str,
    loader: bunwasm_transpiler::Loader,
    map: bool,
) -> Result<String, String> {
    bunwasm_transpiler::register(source, path, loader).map(|t| {
        if map {
            bunwasm_transpiler::source_map_json(path, source, &t.mappings)
        } else {
            t.code
        }
    })
}
