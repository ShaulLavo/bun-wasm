#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Browser,
    Bun,
    Node,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Format {
    #[default]
    Esm,
    Cjs,
    Iife,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SourceMap {
    #[default]
    None,
    Linked,
    Inline,
    External,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Packages {
    Bundle,
    External,
}

/// `bun build` options. Field names follow the CLI flags.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildArgs {
    pub entry_points: Vec<String>,
    /// Directory relative paths are resolved against. Defaults to the process cwd.
    pub cwd: Option<String>,
    pub outdir: Option<String>,
    pub outfile: Option<String>,
    pub root: Option<String>,
    /// `None` is Bun's default (browser).
    pub target: Option<Target>,
    pub format: Format,
    pub minify_syntax: bool,
    pub minify_whitespace: bool,
    pub minify_identifiers: bool,
    pub keep_names: bool,
    pub sourcemap: SourceMap,
    pub splitting: bool,
    pub external: Vec<String>,
    pub packages: Option<Packages>,
    pub define: Vec<(String, String)>,
    pub drop: Vec<String>,
    pub conditions: Vec<String>,
    pub public_path: Option<String>,
    pub banner: Option<String>,
    pub footer: Option<String>,
    pub entry_naming: Option<String>,
    pub chunk_naming: Option<String>,
    pub asset_naming: Option<String>,
    pub production: bool,
    /// `--no-bundle`: transpile each entry point on its own.
    pub no_bundle: bool,
    pub metafile: Option<String>,
    /// `--react-fast-refresh`: `$RefreshReg$`/`$RefreshSig$` calls in JSX files.
    pub react_fast_refresh: bool,
    /// Write the output files to disk. Without it, contents are only returned.
    pub write: bool,
}

impl Default for BuildArgs {
    fn default() -> Self {
        BuildArgs {
            entry_points: Vec::new(),
            cwd: None,
            outdir: None,
            outfile: None,
            root: None,
            target: None,
            format: Format::Esm,
            minify_syntax: false,
            minify_whitespace: false,
            minify_identifiers: false,
            keep_names: false,
            sourcemap: SourceMap::None,
            splitting: false,
            external: Vec::new(),
            packages: None,
            define: Vec::new(),
            drop: Vec::new(),
            conditions: Vec::new(),
            public_path: None,
            banner: None,
            footer: None,
            entry_naming: None,
            chunk_naming: None,
            asset_naming: None,
            production: false,
            no_bundle: false,
            metafile: None,
            react_fast_refresh: false,
            write: true,
        }
    }
}

impl BuildArgs {
    /// `--minify`: all three minify passes.
    pub fn set_minify(&mut self, on: bool) {
        self.minify_syntax = on;
        self.minify_whitespace = on;
        self.minify_identifiers = on;
    }
}

const USAGE_OPTIONS: &str = "<entrypoint>... [--outdir dir | --outfile file] [--minify] \
[--minify-syntax] [--minify-whitespace] [--minify-identifiers] [--format esm|cjs|iife] \
[--target browser|bun|node] [--sourcemap[=linked|inline|external|none]] [--splitting] \
[--external pkg] [--packages bundle|external] [--define K=V] [--root dir] [--public-path p] \
[--entry-naming t] [--chunk-naming t] [--asset-naming t] [--banner s] [--footer s] \
[--production] [--react-fast-refresh] [--no-bundle] [--keep-names] [--metafile[=path]] [--conditions c]";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildEntrypoint {
    Bun,
    Standalone,
}

impl BuildEntrypoint {
    pub fn usage(self) -> String {
        let command = match self {
            Self::Bun => "bun build",
            Self::Standalone => "bun-build",
        };
        format!("usage: {command} {USAGE_OPTIONS}")
    }
}

/// Parse the build command's operands, without its executable or subcommand.
/// `None` requests help. `--cwd` changes the process directory immediately,
/// including before help or errors.
pub fn parse_build_args(
    argv: impl IntoIterator<Item = String>,
    entrypoint: BuildEntrypoint,
) -> Result<Option<BuildArgs>, String> {
    let mut args = BuildArgs::default();
    let mut argv = argv.into_iter();
    while let Some(arg) = argv.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value)),
            _ => (arg.as_str(), None),
        };
        if matches!(flag, "-h" | "--help") {
            return Ok(None);
        }
        parse_argument(&mut args, &mut argv, &arg, flag, inline, entrypoint)?;
    }
    Ok(Some(args))
}

fn parse_argument(
    args: &mut BuildArgs,
    argv: &mut impl Iterator<Item = String>,
    arg: &str,
    flag: &str,
    inline: Option<&str>,
    entrypoint: BuildEntrypoint,
) -> Result<(), String> {
    let mut value = |name: &str| {
        inline
            .map(str::to_owned)
            .or_else(|| argv.next())
            .ok_or_else(|| format!("{name} needs a value"))
    };
    match flag {
        "--outdir" => args.outdir = Some(value("--outdir")?),
        "--outfile" => args.outfile = Some(value("--outfile")?),
        "--root" => args.root = Some(value("--root")?),
        "--cwd" => change_cwd(&value("--cwd")?)?,
        "--minify" => args.set_minify(true),
        "--minify-syntax" => args.minify_syntax = true,
        "--minify-whitespace" => args.minify_whitespace = true,
        "--minify-identifiers" => args.minify_identifiers = true,
        "--keep-names" => args.keep_names = true,
        "--splitting" => args.splitting = true,
        "--production" => args.production = true,
        "--react-fast-refresh" => args.react_fast_refresh = true,
        "--no-bundle" => args.no_bundle = true,
        "--format" => args.format = parse_format(&value("--format")?)?,
        "--target" => args.target = Some(parse_target(&value("--target")?)?),
        "--sourcemap" => args.sourcemap = parse_sourcemap(inline)?,
        "--packages" => args.packages = Some(parse_packages(&value("--packages")?)?),
        "-e" | "--external" => args.external.push(value("--external")?),
        "--define" => args.define.push(parse_define(&value("--define")?)?),
        "--drop" => args.drop.push(value("--drop")?),
        "--conditions" => args.conditions.push(value("--conditions")?),
        "--public-path" => args.public_path = Some(value("--public-path")?),
        "--banner" => args.banner = Some(value("--banner")?),
        "--footer" => args.footer = Some(value("--footer")?),
        "--entry-naming" => args.entry_naming = Some(value("--entry-naming")?),
        "--chunk-naming" => args.chunk_naming = Some(value("--chunk-naming")?),
        "--asset-naming" => args.asset_naming = Some(value("--asset-naming")?),
        "--metafile" => args.metafile = Some(inline.unwrap_or_default().to_owned()),
        flag if flag.starts_with('-') => {
            return Err(format!("unknown flag {flag}\n{}", entrypoint.usage()));
        }
        _ => args.entry_points.push(arg.to_owned()),
    }
    Ok(())
}

fn change_cwd(dir: &str) -> Result<(), String> {
    std::env::set_current_dir(dir).map_err(|error| format!("--cwd {dir}: {error}"))
}

fn parse_format(value: &str) -> Result<Format, String> {
    match value {
        "esm" => Ok(Format::Esm),
        "cjs" => Ok(Format::Cjs),
        "iife" => Ok(Format::Iife),
        other => Err(format!(
            "Invalid value for --format: \"{other}\". Must be 'esm', 'cjs', or 'iife'."
        )),
    }
}

fn parse_target(value: &str) -> Result<Target, String> {
    match value {
        "browser" => Ok(Target::Browser),
        "bun" => Ok(Target::Bun),
        "node" => Ok(Target::Node),
        other => Err(format!("invalid target \"{other}\"")),
    }
}

fn parse_sourcemap(value: Option<&str>) -> Result<SourceMap, String> {
    match value {
        None | Some("" | "linked") => Ok(SourceMap::Linked),
        Some("inline") => Ok(SourceMap::Inline),
        Some("external") => Ok(SourceMap::External),
        Some("none") => Ok(SourceMap::None),
        Some(other) => Err(format!("Invalid sourcemap setting: \"{other}\"")),
    }
}

fn parse_packages(value: &str) -> Result<Packages, String> {
    match value {
        "bundle" => Ok(Packages::Bundle),
        "external" => Ok(Packages::External),
        other => Err(format!("Invalid packages setting: \"{other}\"")),
    }
}

fn parse_define(value: &str) -> Result<(String, String), String> {
    let (key, value) = value
        .split_once(['=', ':'])
        .ok_or("--define expects KEY=VALUE")?;
    Ok((key.to_owned(), value.to_owned()))
}
