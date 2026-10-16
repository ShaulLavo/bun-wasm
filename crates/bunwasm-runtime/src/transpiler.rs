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
    Yaml,
    Json5,
    Jsonc,
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
            "json" => Loader::Json,
            "jsonc" => Loader::Jsonc,
            "json5" => Loader::Json5,
            "yaml" | "yml" => Loader::Yaml,
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
            Loader::Yaml => "yaml",
            Loader::Json5 => "json5",
            Loader::Jsonc => "jsonc",
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
    fn function_imports(&self, _args: &[String], _kind: &str) -> Result<Vec<Vec<usize>>, String> {
        Err("generated imports need Bun's parser".to_owned())
    }

    fn parse_data(&self, _source: &[u8], format: &str) -> Result<String, crate::engine::NativeError> {
        Err(crate::engine::NativeError::error(format!("{format}.parse needs Bun's parser, which this bun.wasm was built without")))
    }

    fn transpile(&self, source: &str, path: &str, loader: Loader) -> Result<String, String>;

    /// Like [`Transpiler::transpile`], plus the source map v3 `mappings`
    /// string (one source: the input) when the transpiler records one. The
    /// runtime uses it to report original positions in stack traces.
    fn transpile_with_map(&self, source: &str, path: &str, loader: Loader) -> Result<Transpiled, String> {
        self.transpile(source, path, loader).map(|code| Transpiled { code, mappings: None })
    }

    /// The ES module at `path` (read from disk) as CommonJS, for `require()`
    /// on an engine that can't evaluate ES modules synchronously (the host
    /// engine). The code starts with [`crate::modules::CJS_WRAPPER_PREFIX`]
    /// (after an optional comment line); imports become `require()` calls with
    /// live bindings. `mappings` maps it back to the file.
    fn esm_to_cjs(&self, path: &str) -> Result<Transpiled, String> {
        Err(format!("require() of ES module {path} needs Bun's bundler, which this bun.wasm was built without"))
    }

    /// `Bun.build`: Bun's bundler. Writes the outputs when `outdir` is set
    /// and returns them either way. Errors are the bundler's log, formatted.
    fn build(&self, _request: &BuildRequest) -> Result<BuildResult, String> {
        Err("Bun.build needs Bun's bundler, which this bun.wasm was built without".to_owned())
    }

    fn dev_server_open(&self, _path: &str) -> Result<DevServerResult, String> {
        Err("HTML development needs Bun's bundler, which this bun.wasm was built without".to_owned())
    }

    fn dev_server_rebuild(&self, _id: u32, _changed: &[String]) -> Result<DevServerResult, String> {
        Err("HTML development needs Bun's bundler, which this bun.wasm was built without".to_owned())
    }

    fn dev_server_close(&self, _id: u32) {}
}

#[derive(Clone, Debug)]
pub struct DevServerFile {
    pub path: String,
    pub contents: Vec<u8>,
    pub mime: String,
}

#[derive(Clone, Debug, Default)]
pub struct DevServerResult {
    pub id: u32,
    pub version: String,
    pub html: Vec<u8>,
    pub files: Vec<DevServerFile>,
    pub watch: Vec<String>,
    pub update: Vec<u8>,
    pub errors: Vec<u8>,
    pub logs: String,
}

/// The `Bun.build` options the runtime passes on (a subset of Bun's
/// `BuildConfig`). Paths are absolute; enum-like fields keep Bun's spelling
/// (`"browser"`, `"esm"`, `"inline"`) and `None` is Bun's default.
#[derive(Clone, Debug, Default)]
pub struct BuildRequest {
    pub entrypoints: Vec<String>,
    pub outdir: Option<String>,
    pub root: Option<String>,
    pub target: Option<String>,
    pub format: Option<String>,
    pub splitting: bool,
    pub external: Vec<String>,
    pub packages: Option<String>,
    pub define: Vec<(String, String)>,
    pub conditions: Vec<String>,
    pub minify_syntax: bool,
    pub minify_whitespace: bool,
    pub minify_identifiers: bool,
    pub sourcemap: Option<String>,
    pub public_path: Option<String>,
    pub entry_naming: Option<String>,
    pub chunk_naming: Option<String>,
    pub asset_naming: Option<String>,
    pub banner: Option<String>,
    pub footer: Option<String>,
    /// Emit `$RefreshReg$`/`$RefreshSig$` calls for React Fast Refresh.
    pub react_fast_refresh: bool,
}

/// One output file of [`Transpiler::build`].
#[derive(Clone, Debug)]
pub struct BuildArtifact {
    /// Absolute when the build had an `outdir`, else `./name.js` like Bun.
    pub path: String,
    /// `"entry-point"`, `"chunk"`, `"asset"`, `"sourcemap"` or `"metafile"`.
    pub kind: &'static str,
    pub contents: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
pub struct BuildResult {
    pub outputs: Vec<BuildArtifact>,
    /// Warnings, formatted. Empty if none.
    pub logs: String,
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
