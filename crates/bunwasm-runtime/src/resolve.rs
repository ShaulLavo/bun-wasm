//! Module resolution: Bun/Node rules for relative paths, extension and index
//! probing, `node_modules` packages (`exports`, `imports`, `module`, `main`) and
//! built-in module names.

use std::cell::{Cell, RefCell};
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
    "assert",
    "assert/strict",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "dns/promises",
    "domain",
    "events",
    "fs",
    "fs/promises",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "path/posix",
    "path/win32",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "readline/promises",
    "repl",
    "stream",
    "stream/consumers",
    "stream/promises",
    "stream/web",
    "string_decoder",
    "sys",
    "test",
    "timers",
    "timers/promises",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "util/types",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib",
];

const BUN_BUILTINS: &[&str] = &[
    "bun",
    "bun:jsc",
    "bun:test",
    "bun:sqlite",
    "bun:ffi",
    "bun:wrap",
    "bun:internal-for-testing",
    "ws",
];

/// Extensions probed for extensionless specifiers, in Bun's order.
const EXTENSIONS: &[&str] = &[
    ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".mts", ".cts", ".json",
];

pub fn builtin_name(spec: &str) -> Option<String> {
    if spec.starts_with("bun:plugin:") || BUN_BUILTINS.contains(&spec) {
        return Some(spec.to_owned());
    }
    let bare = spec.strip_prefix("node:").unwrap_or(spec);
    NODE_BUILTINS
        .contains(&bare)
        .then(|| format!("node:{bare}"))
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
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok());
        let decoded = hex
            .filter(|_| bytes[i] == b'%')
            .and_then(|h| u8::from_str_radix(h, 16).ok());
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

pub struct Resolver {
    custom_conditions: Rc<[String]>,
    object_modules: RefCell<HashMap<String, String>>,
    next_object_module: Cell<u64>,
    /// package.json contents by directory (`None` = no package.json there).
    package_json: RefCell<HashMap<String, Option<Rc<Json>>>>,
    package_errors: RefCell<HashMap<String, ResolveNote>>,
    notes: RefCell<Vec<ResolveNote>>,
}

#[derive(Clone)]
pub struct ResolveNote {
    pub file: String,
    pub line_text: String,
    pub line: usize,
    pub column: usize,
    pub message: String,
}

impl Resolver {
    #[cfg(test)]
    pub fn new() -> Self {
        Self::with_conditions(Vec::new())
    }

    pub fn with_conditions(conditions: Vec<String>) -> Self {
        Self {
            custom_conditions: conditions.into(),
            object_modules: RefCell::new(HashMap::new()),
            next_object_module: Cell::new(0),
            package_json: RefCell::new(HashMap::new()),
            package_errors: RefCell::new(HashMap::new()),
            notes: RefCell::new(Vec::new()),
        }
    }

    pub fn register_object_module(&self, name: &str) -> String {
        let mut modules = self.object_modules.borrow_mut();
        let next = self.next_object_module.get();
        self.next_object_module.set(next + 1);
        let key = format!("bun:plugin:{next}");
        modules.insert(name.to_owned(), key.clone());
        key
    }

    pub fn clear_object_modules(&self) {
        self.object_modules.borrow_mut().clear();
    }

    /// Resolve `spec` imported from the file `from` (or a directory path ending
    /// in `/` for the entry point / eval code).
    pub fn resolve(&self, spec: &str, from: &str, kind: Kind) -> Result<Resolved, String> {
        self.notes.borrow_mut().clear();
        if let Some(key) = self.object_modules.borrow().get(spec) {
            return Ok(Resolved::Builtin(key.clone()));
        }
        if let Some(name) = builtin_name(spec) {
            return Ok(Resolved::Builtin(name));
        }
        if spec.starts_with("node:") {
            return Err(format!("No such built-in module: {spec}"));
        }
        if spec.starts_with("bun:") {
            return Err(format!("Cannot find module '{spec}' from '{from}'"));
        }
        if spec.starts_with("data:") && !spec[5..].contains(',') {
            return Err(format!(
                "Cannot resolve invalid data URL '{spec}' from '{from}'"
            ));
        }
        let from_dir = if from.ends_with('/') {
            from.trim_end_matches('/')
        } else {
            dirname(from)
        };
        let from_dir = if from_dir.is_empty() { "/" } else { from_dir };

        if spec.starts_with("file:") {
            let path = file_url_to_path(spec).ok_or_else(|| format!("Invalid file URL: {spec}"))?;
            return self
                .resolve_path(&path, kind)
                .ok_or_else(|| not_found_module(spec, from));
        }
        if is_relative_or_absolute(spec) {
            let path = join(from_dir, spec);
            return self
                .resolve_path(&path, kind)
                .ok_or_else(|| not_found_module(spec, from));
        }
        if spec.starts_with('#') {
            return self
                .resolve_imports_field(spec, from_dir, kind)
                .ok_or_else(|| not_found_module(spec, from));
        }
        self.resolve_package(spec, from_dir, kind).ok_or_else(|| {
            if spec.contains('/') {
                not_found_module(spec, from)
            } else {
                format!("Cannot find package '{spec}' from '{from}'")
            }
        })
    }

    pub fn notes(&self) -> Vec<ResolveNote> {
        self.notes.borrow().clone()
    }

    /// Resolve an absolute path as a file or directory.
    fn resolve_path(&self, path: &str, kind: Kind) -> Option<Resolved> {
        self.resolve_file(path)
            .or_else(|| self.resolve_directory(path, kind))
            .map(Resolved::File)
    }

    fn resolve_file(&self, path: &str) -> Option<String> {
        if is_file(path) {
            return Some(path.to_owned());
        }
        if let Some(found) = EXTENSIONS
            .iter()
            .map(|ext| format!("{path}{ext}"))
            .find(|p| is_file(p))
        {
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
        alternates
            .iter()
            .map(|alt| format!("{stem}.{alt}"))
            .find(|p| is_file(p))
    }

    fn resolve_directory(&self, dir: &str, kind: Kind) -> Option<String> {
        if !is_dir(dir) {
            return None;
        }
        if let Some(pkg) = self.package_json_in(dir)
            && let Some(found) = self.resolve_main_fields(dir, &pkg, kind)
        {
            return Some(found);
        }
        self.resolve_index(dir)
    }

    fn resolve_index(&self, dir: &str) -> Option<String> {
        EXTENSIONS
            .iter()
            .map(|ext| format!("{dir}/index{ext}"))
            .find(|p| is_file(p))
    }

    /// `main` field of a package without `exports`. Like Bun's runtime,
    /// `module` is only a fallback for packages with no `main`.
    fn resolve_main_fields(&self, dir: &str, pkg: &Json, kind: Kind) -> Option<String> {
        let fields: &[&str] = match kind {
            Kind::Import => &["main", "module"],
            Kind::Require => &["main"],
        };
        for field in fields {
            let Some(main) = pkg.get(*field).and_then(Json::as_str) else {
                continue;
            };
            let path = join(dir, main);
            if let Some(found) = self
                .resolve_file(&path)
                .or_else(|| self.resolve_index(&path))
            {
                return Some(found);
            }
        }
        None
    }

    fn resolve_package(&self, spec: &str, from_dir: &str, kind: Kind) -> Option<Resolved> {
        let (name, subpath) = package_name(spec);
        // A package can import itself by name through its own `exports`.
        if let Some((pkg_dir, pkg)) = self.self_reference_package(name, from_dir) {
            return self
                .resolve_in_package(&pkg_dir, Some(&pkg), &subpath, kind)
                .map(Resolved::File);
        }
        let mut dir = from_dir.to_owned();
        loop {
            let candidate = format!("{}/node_modules/{name}", dir.trim_end_matches('/'));
            match self.resolve_package_candidate(&candidate, &subpath, kind) {
                PackageCandidate::Selected(found) => return found.map(Resolved::File),
                PackageCandidate::Unresolved => (),
            }
            if dir == "/" {
                return None;
            }
            dir = dirname(&dir).to_owned();
        }
    }

    fn resolve_package_candidate(&self, dir: &str, subpath: &str, kind: Kind) -> PackageCandidate {
        if !is_dir(dir) {
            return PackageCandidate::Unresolved;
        }
        let pkg = self.package_json_in(dir);
        let found = self.resolve_in_package(dir, pkg.as_deref(), subpath, kind);
        // Exports select this package even when its chosen target cannot resolve.
        // Bun still searches ancestors for unresolved legacy main/index lookups.
        if found.is_some() || pkg.as_deref().and_then(package_exports).is_some() {
            return PackageCandidate::Selected(found);
        }
        PackageCandidate::Unresolved
    }

    fn self_reference_package(&self, name: &str, from_dir: &str) -> Option<(String, Rc<Json>)> {
        let (pkg_dir, pkg) = self.nearest_package_json(from_dir)?;
        if pkg.get("name").and_then(Json::as_str) != Some(name) || package_exports(&pkg).is_none() {
            return None;
        }
        Some((pkg_dir, pkg))
    }

    fn resolve_in_package(
        &self,
        pkg_dir: &str,
        pkg: Option<&Json>,
        subpath: &str,
        kind: Kind,
    ) -> Option<String> {
        if let Some(exports) = pkg.and_then(package_exports) {
            return resolve_exports(pkg_dir, exports, subpath, kind, &self.custom_conditions)
                .filter(|p| is_file(p));
        }
        if subpath == "." {
            if let Some(found) = pkg.and_then(|p| self.resolve_main_fields(pkg_dir, p, kind)) {
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
        let target = match_subpath_map(
            imports,
            spec,
            kind,
            TargetMap::Imports,
            &self.custom_conditions,
        )
        .into_path()?;
        if target.starts_with("./") {
            return Some(Resolved::File(join(&pkg_dir, &target)))
                .filter(|r| matches!(r, Resolved::File(p) if is_file(p)));
        }
        // An import map entry may point at a package or built-in.
        self.resolve(&target, &format!("{pkg_dir}/"), kind).ok()
    }

    pub fn package_json_in(&self, dir: &str) -> Option<Rc<Json>> {
        if let Some(cached) = self.package_json.borrow().get(dir) {
            if let Some(note) = self.package_errors.borrow().get(dir) {
                self.notes.borrow_mut().push(note.clone());
            }
            return cached.clone();
        }
        let parsed = self.read_package_json(dir).map(Rc::new);
        self.package_json
            .borrow_mut()
            .insert(dir.to_owned(), parsed.clone());
        parsed
    }

    fn read_package_json(&self, dir: &str) -> Option<Json> {
        let file = format!("{dir}/package.json");
        let text = fs::read_to_string(&file).ok()?;
        match serde_json::from_str::<Json>(&text) {
            Ok(value) => Some(value),
            Err(error) => {
                let prefix = if error.is_eof() {
                    text.trim_end()
                } else {
                    &text
                };
                let line = if error.is_eof() {
                    prefix.lines().count().max(1)
                } else {
                    error.line()
                };
                let line_text = prefix
                    .lines()
                    .nth(line.saturating_sub(1))
                    .unwrap_or("")
                    .to_owned();
                let column = if error.is_eof() {
                    line_text.len() + 1
                } else {
                    error.column()
                };
                let message = if error.is_eof() {
                    "Unexpected end of file".to_owned()
                } else {
                    error.to_string()
                };
                let note = ResolveNote {
                    file,
                    line_text,
                    line,
                    column,
                    message,
                };
                self.notes.borrow_mut().push(note.clone());
                self.package_errors
                    .borrow_mut()
                    .insert(dir.to_owned(), note);
                None
            }
        }
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
    spec.starts_with('/')
        || spec.starts_with("./")
        || spec.starts_with("../")
        || spec == "."
        || spec == ".."
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

fn builtin_condition(kind: Kind, condition: &str) -> bool {
    match kind {
        Kind::Import => matches!(condition, "bun" | "node" | "import" | "default"),
        Kind::Require => matches!(condition, "bun" | "node" | "require" | "default"),
    }
}

fn package_exports(pkg: &Json) -> Option<&Json> {
    pkg.get("exports").filter(|exports| !exports.is_null())
}

enum PackageCandidate {
    Unresolved,
    Selected(Option<String>),
}

#[derive(Clone, Copy)]
enum TargetMap {
    Exports,
    Imports,
}

#[derive(Debug, PartialEq, Eq)]
enum PackageTarget {
    Unmatched,
    Null,
    Invalid,
    Path(String),
}

impl PackageTarget {
    fn into_path(self) -> Option<String> {
        match self {
            Self::Path(path) => Some(path),
            Self::Unmatched | Self::Null | Self::Invalid => None,
        }
    }
}

/// Node's PACKAGE_EXPORTS_RESOLVE.
fn resolve_exports(
    pkg_dir: &str,
    exports: &Json,
    subpath: &str,
    kind: Kind,
    custom_conditions: &[String],
) -> Option<String> {
    let is_subpath_map = exports
        .as_object()
        .is_some_and(|map| map.keys().next().is_some_and(|k| k.starts_with('.')));
    let target = if is_subpath_map {
        match_subpath_map(
            exports.as_object()?,
            subpath,
            kind,
            TargetMap::Exports,
            custom_conditions,
        )
    } else if subpath == "." {
        resolve_target(exports, kind, None, TargetMap::Exports, custom_conditions)
    } else {
        return None;
    };
    Some(join(pkg_dir, &target.into_path()?))
}

/// Match exact keys before patterns, ordered by prefix length then full key length.
fn match_subpath_map(
    map: &serde_json::Map<String, Json>,
    key: &str,
    kind: Kind,
    target_map: TargetMap,
    custom_conditions: &[String],
) -> PackageTarget {
    if let Some(target) = map.get(key).filter(|_| !key.contains('*')) {
        return resolve_target(target, kind, None, target_map, custom_conditions);
    }
    let mut best: Option<(&str, &Json, &str)> = None;
    for (pattern, target) in map {
        let Some((prefix, suffix)) = pattern.split_once('*') else {
            continue;
        };
        if suffix.contains('*')
            || !key.starts_with(prefix)
            || !key.ends_with(suffix)
            || key.len() <= prefix.len() + suffix.len()
        {
            continue;
        }
        let captured = &key[prefix.len()..key.len() - suffix.len()];
        if best
            .as_ref()
            .is_none_or(|(p, _, _)| pattern_priority(pattern) > pattern_priority(p))
        {
            best = Some((pattern, target, captured));
        }
    }
    if let Some((_, target, captured)) = best {
        return resolve_pattern_target(target, captured, kind, target_map, custom_conditions);
    }
    // Legacy folder mappings: "./dir/": "./lib/dir/".
    let folder = map
        .iter()
        .filter(|(k, _)| k.ends_with('/') && key.starts_with(k.as_str()))
        .max_by_key(|(k, _)| k.len());
    let Some((folder, target)) = folder else {
        return PackageTarget::Unmatched;
    };
    match resolve_target(target, kind, None, target_map, custom_conditions) {
        PackageTarget::Path(path) => PackageTarget::Path(format!("{path}{}", &key[folder.len()..])),
        other => other,
    }
}

fn resolve_pattern_target(
    target: &Json,
    captured: &str,
    kind: Kind,
    target_map: TargetMap,
    custom_conditions: &[String],
) -> PackageTarget {
    if invalid_target_segments(captured) {
        return PackageTarget::Invalid;
    }
    resolve_target(target, kind, Some(captured), target_map, custom_conditions)
}

fn pattern_priority(pattern: &str) -> (usize, usize) {
    (pattern.find('*').unwrap_or(pattern.len()), pattern.len())
}

fn resolve_target(
    target: &Json,
    kind: Kind,
    captured: Option<&str>,
    target_map: TargetMap,
    custom_conditions: &[String],
) -> PackageTarget {
    match target {
        Json::Null => PackageTarget::Null,
        Json::String(path) => resolve_string_target(path, captured, target_map),
        Json::Array(items) => {
            resolve_target_array(items, kind, captured, target_map, custom_conditions)
        }
        Json::Object(map) => {
            resolve_target_conditions(map, kind, captured, target_map, custom_conditions)
        }
        _ => PackageTarget::Invalid,
    }
}

fn resolve_string_target(
    path: &str,
    captured: Option<&str>,
    target_map: TargetMap,
) -> PackageTarget {
    let path = match captured {
        Some(captured) => path.replace('*', captured),
        None => path.to_owned(),
    };
    if let Some(relative) = path.strip_prefix("./") {
        return if invalid_target_segments(relative) {
            PackageTarget::Invalid
        } else {
            PackageTarget::Path(path)
        };
    }
    if matches!(target_map, TargetMap::Exports) || is_relative_or_absolute(&path) || path.is_empty()
    {
        return PackageTarget::Invalid;
    }
    PackageTarget::Path(path)
}

fn invalid_target_segments(path: &str) -> bool {
    percent_decode(path)
        .split(['/', '\\'])
        .any(|part| part == "." || part == ".." || part.eq_ignore_ascii_case("node_modules"))
}

fn resolve_target_array(
    items: &[Json],
    kind: Kind,
    captured: Option<&str>,
    target_map: TargetMap,
    custom_conditions: &[String],
) -> PackageTarget {
    if items.is_empty() {
        return PackageTarget::Null;
    }
    let mut last = PackageTarget::Unmatched;
    for target in items {
        match resolve_target(target, kind, captured, target_map, custom_conditions) {
            PackageTarget::Path(path) => return PackageTarget::Path(path),
            PackageTarget::Unmatched => (),
            other => last = other,
        }
    }
    last
}

fn resolve_target_conditions(
    map: &serde_json::Map<String, Json>,
    kind: Kind,
    captured: Option<&str>,
    target_map: TargetMap,
    custom_conditions: &[String],
) -> PackageTarget {
    map.iter()
        .filter(|(condition, _)| {
            builtin_condition(kind, condition)
                || custom_conditions.iter().any(|custom| custom == *condition)
        })
        .find_map(|(_, target)| {
            match resolve_target(target, kind, captured, target_map, custom_conditions) {
                PackageTarget::Unmatched => None,
                selected => Some(selected),
            }
        })
        .unwrap_or(PackageTarget::Unmatched)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(package_name("lodash"), ("lodash", ".".to_owned()));
        assert_eq!(
            package_name("lodash/fp/map"),
            ("lodash", "./fp/map".to_owned())
        );
        assert_eq!(package_name("@a/b/c"), ("@a/b", "./c".to_owned()));
        assert_eq!(normalize("/a/./b/../c//d"), "/a/c/d");
        assert_eq!(dirname("/a/b.js"), "/a");
        assert_eq!(dirname("/b.js"), "/");
    }
}

#[cfg(test)]
#[path = "resolve_tests.rs"]
mod package_tests;
