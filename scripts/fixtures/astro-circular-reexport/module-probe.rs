use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::{Context, Ctx, Error, Module, Runtime};
use std::path::{Path, PathBuf};

struct FileResolver;

impl Resolver for FileResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        let path = if name.starts_with('.') {
            Path::new(base).parent().expect("module parent").join(name)
        } else {
            PathBuf::from(name)
        };
        let resolved = std::fs::canonicalize(path).expect("resolve module");
        Ok(resolved.to_string_lossy().into_owned())
    }
}

struct FileLoader;

impl Loader for FileLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js, rquickjs::module::Declared>> {
        let source = std::fs::read_to_string(name).expect("load module");
        Module::declare(ctx.clone(), name, source)
    }
}

fn describe(ctx: &Ctx<'_>, error: Error) -> String {
    match error {
        Error::Exception => {
            let error = ctx.catch();
            let name = error
                .as_object()
                .and_then(|object| object.get::<_, String>("name").ok())
                .unwrap_or_else(|| "Exception".to_owned());
            let message = error
                .as_object()
                .and_then(|object| object.get::<_, String>("message").ok())
                .unwrap_or_else(|| format!("{error:?}"));
            format!("{name}: {message}")
        }
        other => other.to_string(),
    }
}

fn main() {
    let entry = std::env::args().nth(1).expect("entry module");
    let entry = std::fs::canonicalize(entry).expect("canonical entry");
    let name = entry.to_string_lossy().into_owned();
    let source = std::fs::read_to_string(&entry).expect("read entry");
    let runtime = Runtime::new().expect("runtime");
    runtime.set_loader(FileResolver, FileLoader);
    let context = Context::full(&runtime).expect("context");
    let result = context.with(|ctx| {
        let promise = Module::evaluate(ctx.clone(), name, source).map_err(|error| describe(&ctx, error))?;
        promise.finish::<()>().map_err(|error| describe(&ctx, error))
    });
    if let Err(message) = result {
        eprintln!("{message}");
        std::process::exit(2);
    }
    println!("PASS module-contract");
}
