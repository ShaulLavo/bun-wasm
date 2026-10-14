//! The hook between the runtime and a source transpiler.
//!
//! The runtime hands every JS-like source file (and TOML) to a [`Transpiler`]
//! before evaluating it. The output must be ESM JavaScript: `import`/`export`
//! preserved, types stripped, JSX lowered to function calls. CommonJS sources
//! are passed through untouched apart from those transforms; the runtime decides
//! afterwards whether the result is a CommonJS or an ES module.
//!
//! JSON and plain-text files never reach the transpiler: the runtime loads them
//! itself.

use std::fmt;

/// How a source file should be parsed. Picked from the file extension.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Loader {
    Js,
    Jsx,
    Ts,
    Tsx,
    Json,
    Toml,
    Text,
}

impl Loader {
    /// Loader for a path, by extension. Unknown extensions load as JS, like Bun.
    pub fn from_path(path: &str) -> Loader {
        let ext = path.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
        match ext {
            "jsx" => Loader::Jsx,
            "ts" | "mts" | "cts" => Loader::Ts,
            "tsx" => Loader::Tsx,
            "json" | "jsonc" => Loader::Json,
            "toml" => Loader::Toml,
            "txt" | "md" | "html" | "css" | "svg" => Loader::Text,
            _ => Loader::Js,
        }
    }
}

impl fmt::Display for Loader {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Loader::Js => "js",
            Loader::Jsx => "jsx",
            Loader::Ts => "ts",
            Loader::Tsx => "tsx",
            Loader::Json => "json",
            Loader::Toml => "toml",
            Loader::Text => "text",
        };
        f.write_str(name)
    }
}

/// Turns a source file into ESM JavaScript the engine can run.
///
/// `path` is the absolute path of the file (used for error messages and JSX/TS
/// settings lookups). Errors are returned as a human readable message, which
/// the runtime throws as a `SyntaxError`-like error in JS.
pub trait Transpiler {
    fn transpile(&self, source: &str, path: &str, loader: Loader) -> Result<String, String>;

    /// Like [`Transpiler::transpile`], plus the source map v3 `mappings`
    /// string (one source: the input) when the transpiler records one. The
    /// runtime uses it to report original positions in stack traces.
    fn transpile_with_map(&self, source: &str, path: &str, loader: Loader) -> Result<Transpiled, String> {
        self.transpile(source, path, loader).map(|code| Transpiled { code, mappings: None })
    }
}

/// Transpiler output with an optional source map.
#[derive(Clone, Debug, Default)]
pub struct Transpiled {
    pub code: String,
    pub mappings: Option<String>,
}

/// Stand-in until Bun's real transpiler is wired in: plain JavaScript passes
/// through unchanged, everything that needs real transpiling is refused with a
/// clear message.
#[derive(Clone, Copy, Debug, Default)]
pub struct PassthroughTranspiler;

impl Transpiler for PassthroughTranspiler {
    fn transpile(&self, source: &str, path: &str, loader: Loader) -> Result<String, String> {
        match loader {
            Loader::Js => Ok(source.to_owned()),
            other => Err(format!(
                "Cannot load {path}: the {other} loader needs Bun's transpiler, which this \
                 bun.wasm was built without (rebuild bunwasm-cli with --features bun-transpiler)"
            )),
        }
    }
}
