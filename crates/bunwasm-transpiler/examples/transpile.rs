//! `transpile [--map] [--register] [--await-hooks] <file>`: print Bun's output.
//! `--map` prints the source map; `--register` prints a module registration record;
//! `--await-hooks` enables browser-engine context hooks.
fn transform(
    source: &str,
    path: &str,
    loader: bunwasm_transpiler::Loader,
    map: bool,
    register: bool,
) -> Result<String, String> {
    let printed = if register {
        bunwasm_transpiler::register(source, path, loader)?
    } else if map {
        bunwasm_transpiler::transpile_with_source_map(source, path, loader, false)?
    } else {
        return bunwasm_transpiler::transpile(source, path, loader);
    };
    Ok(if map {
        bunwasm_transpiler::source_map_json(path, source, &printed.mappings)
    } else {
        printed.code
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let map = args.iter().any(|a| a == "--map");
    let register = args.iter().any(|a| a == "--register");
    let hooks = args.iter().any(|a| a == "--await-hooks");
    let path = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .expect("usage: transpile [--map] [--register] [--await-hooks] <file>");
    let source = std::fs::read_to_string(path).expect("read input");
    let loader =
        bunwasm_transpiler::Loader::from_path(path).unwrap_or(bunwasm_transpiler::Loader::Ts);
    let result = bunwasm_transpiler::with_await_hooks(hooks, || {
        transform(&source, path, loader, map, register)
    });
    match result {
        Ok(out) => print!("{out}"),
        Err(e) => {
            eprint!("{e}");
            std::process::exit(1);
        }
    }
}
