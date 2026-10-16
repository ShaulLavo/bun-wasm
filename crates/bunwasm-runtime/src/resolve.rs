//! Module resolution: Bun/Node rules for relative paths, extension and index
//! probing, `node_modules` packages (`exports`, `imports`, `module`, `main`) and
//! built-in module names.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::rc::Rc;

use serde_json::Value as Json;

/// Whether the specifier came from `import`/`import()` or from `require()`.
/// Picks the `exports` condition and the main field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Import,
    Require,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolved {
    /// Canonical built-in name: `node:fs`, `bun`, `bun:jsc`, ...
    Builtin(String),
    /// Absolute, normalized file path.
    File(String),
}

/// Node built-ins we know by name. Some are only stubs that throw on use, but
/// every one of them can be imported.
pub const NODE_BUILTINS: &[&str] = &[
    "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console",
    "constants", "crypto", "dgram", "diagnostics_channel", "dns", "dns/promises", "domain",
    "events", "fs", "fs/promises", "http", "http2", "https", "inspector", "module", "net", "os",
    "path", "path/posix", "path/win32", "perf_hooks", "process", "punycode", "querystring",
    "readline", "readline/promises", "repl", "stream", "stream/promises", "stream/web",
    "string_decoder", "sys", "test", "timers", "timers/promises", "tls", "tty", "url", "util",
    "util/types", "v8", "vm", "wasi", "worker_threads", "zlib",
];

const BUN_BUILTINS: &[&str] = &["bun", "bun:jsc", "bun:test", "bun:sqlite", "bun:ffi", "bun:wrap", "bun:internal-for-testing", "ws"];

/// Extensions probed for extensionless specifiers, in Bun's order.
const EXTENSIONS: &[&str] = &[".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".mts", ".cts", ".json"];

pub fn builtin_name(spec: &str) -> Option<String> {
    if BUN_BUILTINS.contains(&spec) {
        return Some(spec.to_owned());
    }
    let bare = spec.strip_prefix("node:").unwrap_or(spec);
    NODE_BUILTINS.contains(&bare).then(|| format!("node:{bare}"))
}

/// Lexically normalize an absolute POSIX path (`.`/`..`/duplicate slashes).
pub fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

pub fn join(base: &str, rel: &str) -> String {
    if rel.starts_with('/') {
        return normalize(rel);
    }
    normalize(&format!("{base}/{rel}"))
}

pub fn dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) => "/",
        Some(i) => &path[..i],
        None => ".",
    }
}

fn is_file(path: &str) -> bool {
    fs::metadata(path).map(|m| m.is_file()).unwrap_or(false)
}

fn is_dir(path: &str) -> bool {
    fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

/// File URL → path, for `import "file:///x.js"`.
fn file_url_to_path(spec: &str) -> Option<String> {
    let url = url::Url::parse(spec).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    let decoded = percent_decode(url.path());
    Some(decoded)
}

pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok());
        let decoded = hex.filter(|_| bytes[i] == b'%').and_then(|h| u8::from_str_radix(h, 16).ok());
        match decoded {
            Some(b) => {
                out.push(b);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Default)]
pub struct Resolver {
    /// package.json contents by directory (`None` = no package.json there).
    package_json: RefCell<HashMap<String, Option<Rc<Json>>>>,
}

impl Resolver {
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve `spec` imported from the file `from` (or a directory path ending
    /// in `/` for the entry point / eval code).
    pub fn resolve(&self, spec: &str, from: &str, kind: Kind) -> Result<Resolved, String> {
        if let Some(name) = builtin_name(spec) {
            return Ok(Resolved::Builtin(name));
        }
        if spec.starts_with("node:") {
            return Err(format!("No such built-in module: {spec}"));
        }
        if spec.starts_with("bun:") {
            return Err(format!("Cannot find module '{spec}' from '{from}'"));
        }
        let from_dir = if from.ends_with('/') { from.trim_end_matches('/') } else { dirname(from) };
        let from_dir = if from_dir.is_empty() { "/" } else { from_dir };

        if spec.starts_with("file:") {
            let path = file_url_to_path(spec).ok_or_else(|| format!("Invalid file URL: {spec}"))?;
            return self.resolve_path(&path, kind).ok_or_else(|| not_found_module(spec, from));
        }
        if is_relative_or_absolute(spec) {
            let path = join(from_dir, spec);
            return self.resolve_path(&path, kind).ok_or_else(|| not_found_module(spec, from));
        }
        if spec.starts_with('#') {
            return self.resolve_imports_field(spec, from_dir, kind).ok_or_else(|| not_found_module(spec, from));
        }
        self.resolve_package(spec, from_dir, kind)
            .ok_or_else(|| format!("Cannot find package '{}' from '{from}'", package_name(spec).0))
    }

    /// Resolve an absolute path as a file or directory.
    fn resolve_path(&self, path: &str, kind: Kind) -> Option<Resolved> {
        self.resolve_file(path).or_else(|| self.resolve_directory(path, kind)).map(Resolved::File)
    }

    fn resolve_file(&self, path: &str) -> Option<String> {
        if is_file(path) {
            return Some(path.to_owned());
        }
        if let Some(found) = EXTENSIONS.iter().map(|ext| format!("{path}{ext}")).find(|p| is_file(p)) {
            return Some(found);
        }
        // TypeScript-style imports: "./foo.js" may name "./foo.ts".
        let (stem, ext) = path.rsplit_once('.')?;
        let alternates: &[&str] = match ext {
            "js" => &["ts", "tsx"],
            "jsx" => &["tsx", "ts"],
            "mjs" => &["mts"],
            "cjs" => &["cts"],
            _ => &[],
        };
        alternates.iter().map(|alt| format!("{stem}.{alt}")).find(|p| is_file(p))
    }

    fn resolve_directory(&self, dir: &str, kind: Kind) -> Option<String> {
        if !is_dir(dir) {
            return None;
        }
        if let Some(pkg) = self.package_json_in(dir) {
            if let Some(found) = self.resolve_main_fields(dir, &pkg, kind) {
                return Some(found);
            }
        }
        self.resolve_index(dir)
    }

    fn resolve_index(&self, dir: &str) -> Option<String> {
        EXTENSIONS.iter().map(|ext| format!("{dir}/index{ext}")).find(|p| is_file(p))
    }

    /// `main` field of a package without `exports`. Like Bun's runtime,
    /// `module` is only a fallback for packages with no `main`.
    fn resolve_main_fields(&self, dir: &str, pkg: &Json, kind: Kind) -> Option<String> {
        let fields: &[&str] = match kind {
            Kind::Import => &["main", "module"],
            Kind::Require => &["main"],
        };
        for field in fields {
            let Some(main) = pkg.get(*field).and_then(Json::as_str) else { continue };
            let path = join(dir, main);
            if let Some(found) = self.resolve_file(&path).or_else(|| self.resolve_index(&path)) {
                return Some(found);
            }
        }
        None
    }

    fn resolve_package(&self, spec: &str, from_dir: &str, kind: Kind) -> Option<Resolved> {
        let (name, subpath) = package_name(spec);
        // A package can import itself by name through its own `exports`.
        if let Some(found) = self.resolve_self_reference(name, &subpath, from_dir, kind) {
            return Some(Resolved::File(found));
        }
        let mut dir = from_dir.to_owned();
        loop {
            let candidate = format!("{}/node_modules/{name}", dir.trim_end_matches('/'));
            if is_dir(&candidate) {
                if let Some(found) = self.resolve_in_package(&candidate, &subpath, kind) {
                    return Some(Resolved::File(found));
                }
            }
            if dir == "/" {
                return None;
            }
            dir = dirname(&dir).to_owned();
        }
    }

    fn resolve_self_reference(&self, name: &str, subpath: &str, from_dir: &str, kind: Kind) -> Option<String> {
        let (pkg_dir, pkg) = self.nearest_package_json(from_dir)?;
        if pkg.get("name").and_then(Json::as_str) != Some(name) {
            return None;
        }
        let exports = pkg.get("exports")?;
        resolve_exports(&pkg_dir, exports, subpath, kind).filter(|p| is_file(p))
    }

    fn resolve_in_package(&self, pkg_dir: &str, subpath: &str, kind: Kind) -> Option<String> {
        let pkg = self.package_json_in(pkg_dir);
        if let Some(exports) = pkg.as_ref().and_then(|p| p.get("exports")) {
            return resolve_exports(pkg_dir, exports, subpath, kind).filter(|p| is_file(p));
        }
        if subpath == "." {
            if let Some(found) = pkg.as_ref().and_then(|p| self.resolve_main_fields(pkg_dir, p, kind)) {
                return Some(found);
            }
            return self.resolve_index(pkg_dir);
        }
        let path = join(pkg_dir, subpath);
        match self.resolve_path(&path, kind)? {
            Resolved::File(f) => Some(f),
            Resolved::Builtin(_) => None,
        }
    }

    /// `#internal` specifiers via the nearest package.json `imports` field.
    fn resolve_imports_field(&self, spec: &str, from_dir: &str, kind: Kind) -> Option<Resolved> {
        let (pkg_dir, pkg) = self.nearest_package_json(from_dir)?;
        let imports = pkg.get("imports")?.as_object()?;
        let target = match_subpath_map(imports, spec, kind)?;
        if target.starts_with("./") {
            return Some(Resolved::File(join(&pkg_dir, &target))).filter(|r| matches!(r, Resolved::File(p) if is_file(p)));
        }
        // An import map entry may point at a package or built-in.
        self.resolve(&target, &format!("{pkg_dir}/"), kind).ok()
    }

    pub fn package_json_in(&self, dir: &str) -> Option<Rc<Json>> {
        if let Some(cached) = self.package_json.borrow().get(dir) {
            return cached.clone();
        }
        let parsed = fs::read_to_string(format!("{dir}/package.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Json>(&text).ok())
            .map(Rc::new);
        self.package_json.borrow_mut().insert(dir.to_owned(), parsed.clone());
        parsed
    }

    /// Nearest package.json at or above `dir`.
    pub fn nearest_package_json(&self, dir: &str) -> Option<(String, Rc<Json>)> {
        let mut dir = dir.to_owned();
        loop {
            if let Some(pkg) = self.package_json_in(&dir) {
                return Some((dir, pkg));
            }
            if dir == "/" || dir.is_empty() || dir == "." {
                return None;
            }
            dir = dirname(&dir).to_owned();
        }
    }

    /// The `type` field governing a file: `Some(true)` for "module",
    /// `Some(false)` for "commonjs", `None` when unspecified.
    pub fn package_type_is_module(&self, file: &str) -> Option<bool> {
        let (_, pkg) = self.nearest_package_json(dirname(file))?;
        match pkg.get("type").and_then(Json::as_str)? {
            "module" => Some(true),
            "commonjs" => Some(false),
            _ => None,
        }
    }
}

fn is_relative_or_absolute(spec: &str) -> bool {
    spec.starts_with('/') || spec.starts_with("./") || spec.starts_with("../") || spec == "." || spec == ".."
}

fn not_found_module(spec: &str, from: &str) -> String {
    format!("Cannot find module '{spec}' from '{from}'")
}

/// Split `@scope/pkg/sub/path` into (`@scope/pkg`, `./sub/path`).
fn package_name(spec: &str) -> (&str, String) {
    let mut slashes = spec.match_indices('/').map(|(i, _)| i);
    let end = if spec.starts_with('@') {
        slashes.nth(1)
    } else {
        slashes.next()
    };
    match end {
        Some(i) => (&spec[..i], format!(".{}", &spec[i..])),
        None => (spec, ".".to_owned()),
    }
}

fn conditions(kind: Kind) -> &'static [&'static str] {
    match kind {
        Kind::Import => &["bun", "node", "import", "default"],
        Kind::Require => &["bun", "node", "require", "default"],
    }
}

/// Node's PACKAGE_EXPORTS_RESOLVE.
fn resolve_exports(pkg_dir: &str, exports: &Json, subpath: &str, kind: Kind) -> Option<String> {
    let is_subpath_map = exports
        .as_object()
        .is_some_and(|map| map.keys().next().is_some_and(|k| k.starts_with('.')));
    let target = if is_subpath_map {
        match_subpath_map(exports.as_object()?, subpath, kind)?
    } else if subpath == "." {
        resolve_target(exports, kind, None)?
    } else {
        return None;
    };
    Some(join(pkg_dir, &target))
}

/// Match `key` against a subpath map (`exports` or `imports`), including
/// `*` patterns; returns the chosen target string.
fn match_subpath_map(map: &serde_json::Map<String, Json>, key: &str, kind: Kind) -> Option<String> {
    if let Some(target) = map.get(key).filter(|_| !key.contains('*')) {
        return resolve_target(target, kind, None);
    }
    // Longest prefix wins among "./prefix*suffix" patterns.
    let mut best: Option<(&str, &Json, String)> = None;
    for (pattern, target) in map {
        let Some((prefix, suffix)) = pattern.split_once('*') else { continue };
        if !key.starts_with(prefix) || !key.ends_with(suffix) || key.len() < prefix.len() + suffix.len() {
            continue;
        }
        let captured = key[prefix.len()..key.len() - suffix.len()].to_owned();
        if best.as_ref().is_none_or(|(p, _, _)| prefix.len() > p.len()) {
            best = Some((prefix, target, captured));
        }
    }
    if let Some((_, target, captured)) = best {
        return resolve_target(target, kind, Some(&captured));
    }
    // Legacy folder mappings: "./dir/": "./lib/dir/".
    map.iter()
        .filter(|(k, _)| k.ends_with('/') && key.starts_with(k.as_str()))
        .max_by_key(|(k, _)| k.len())
        .and_then(|(k, target)| resolve_target(target, kind, None).map(|t| format!("{t}{}", &key[k.len()..])))
}

fn resolve_target(target: &Json, kind: Kind, captured: Option<&str>) -> Option<String> {
    match target {
        Json::String(s) => Some(match captured {
            Some(c) => s.replace('*', c),
            None => s.clone(),
        }),
        Json::Array(items) => items.iter().find_map(|t| resolve_target(t, kind, captured)),
        Json::Object(map) => map
            .iter()
            .filter(|(cond, _)| conditions(kind).contains(&cond.as_str()))
            .find_map(|(_, t)| resolve_target(t, kind, captured)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(package_name("lodash"), ("lodash", ".".to_owned()));
        assert_eq!(package_name("lodash/fp/map"), ("lodash", "./fp/map".to_owned()));
        assert_eq!(package_name("@a/b/c"), ("@a/b", "./c".to_owned()));
        assert_eq!(normalize("/a/./b/../c//d"), "/a/c/d");
        assert_eq!(dirname("/a/b.js"), "/a");
        assert_eq!(dirname("/b.js"), "/");
    }
}
