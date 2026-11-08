//! Process-local import requests and text-only ESM identities.
use std::collections::HashMap;

use crate::data::NativeError;
use crate::resolve::{self, Kind, Resolved};
use crate::{State, modules};

const REQUEST: &str = "bunwasm:request:";
const TEXT: &str = "bunwasm:text:";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ImportMode {
    Inferred,
    Text,
}

pub struct ImportRequest<'a> {
    pub specifier: &'a str,
    pub mode: ImportMode,
}

pub struct RequestToken(String);
impl RequestToken {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

pub struct ModuleName(String);
impl ModuleName {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

pub type InternImport<'a> = dyn for<'s> FnMut(ImportRequest<'s>) -> RequestToken + 'a;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct TextModuleKey {
    path: String,
}

#[derive(Default)]
pub(crate) struct ImportRequests {
    requests: HashMap<(String, ImportMode), String>,
    tokens: HashMap<String, (String, ImportMode)>,
    modules: HashMap<TextModuleKey, String>,
    paths: HashMap<String, String>,
}

impl State {
    pub fn intern_import_request(&self, request: ImportRequest<'_>) -> RequestToken {
        let key = (request.specifier.to_owned(), request.mode);
        let mut table = self.import_requests.borrow_mut();
        if let Some(token) = table.requests.get(&key) {
            return RequestToken(token.clone());
        }
        let token = format!("{REQUEST}{}", table.requests.len());
        table.tokens.insert(token.clone(), key.clone());
        table.requests.insert(key, token.clone());
        RequestToken(token)
    }

    pub fn module_path(&self, name: &str) -> String {
        self.import_requests
            .borrow()
            .paths
            .get(name)
            .cloned()
            .unwrap_or_else(|| name.to_owned())
    }

    pub fn resolve_module_name(
        &self,
        specifier: &str,
        referrer: &str,
    ) -> Result<ModuleName, NativeError> {
        let table = self.import_requests.borrow();
        if table.paths.contains_key(specifier) {
            return Ok(ModuleName(specifier.to_owned()));
        }
        let request = table.tokens.get(specifier).cloned();
        drop(table);
        if let Some((specifier, mode)) = request {
            return self.resolve_import(
                ImportRequest {
                    specifier: &specifier,
                    mode,
                },
                referrer,
            );
        }
        if specifier.starts_with(REQUEST) || specifier.starts_with(TEXT) {
            return Err(NativeError::type_error("Unknown process import identity"));
        }
        self.resolve_physical_import(specifier, referrer, ImportMode::Inferred)
    }

    pub fn resolve_import(
        &self,
        request: ImportRequest<'_>,
        referrer: &str,
    ) -> Result<ModuleName, NativeError> {
        if request.mode == ImportMode::Inferred {
            return self.resolve_module_name(request.specifier, referrer);
        }
        self.resolve_physical_import(request.specifier, referrer, request.mode)
    }

    fn resolve_physical_import(
        &self,
        specifier: &str,
        referrer: &str,
        mode: ImportMode,
    ) -> Result<ModuleName, NativeError> {
        let path = self.module_path(referrer);
        let from = if path.is_empty() || resolve::builtin_name(&path).is_some() {
            format!("{}/", self.cwd())
        } else {
            path
        };
        let resolved = self
            .resolver
            .resolve(specifier, &from, Kind::Import)
            .map_err(|message| {
                modules::resolve_error(
                    &message,
                    specifier,
                    &from,
                    Kind::Import,
                    self.resolver.notes(),
                )
            })?;
        let path = match resolved {
            Resolved::Builtin(name) if mode == ImportMode::Inferred => return Ok(ModuleName(name)),
            Resolved::Builtin(_) => {
                return Err(NativeError::type_error("Text imports require a file")
                    .prop("specifier", specifier)
                    .prop("referrer", from));
            }
            Resolved::File(path) => path,
        };
        if mode == ImportMode::Inferred {
            return Ok(ModuleName(path));
        }
        let key = TextModuleKey { path: path.clone() };
        let mut table = self.import_requests.borrow_mut();
        if let Some(name) = table.modules.get(&key) {
            return Ok(ModuleName(name.clone()));
        }
        let name = format!("{TEXT}{}", table.modules.len());
        table.paths.insert(name.clone(), path);
        table.modules.insert(key, name.clone());
        Ok(ModuleName(name))
    }

    pub fn text_module_source(&self, name: &ModuleName) -> Result<Option<String>, NativeError> {
        let path = self
            .import_requests
            .borrow()
            .paths
            .get(name.as_str())
            .cloned();
        let Some(path) = path else {
            return Ok(None);
        };
        let bytes = std::fs::read(&path)
            .map_err(|error| crate::natives::io_error(error, "open", Some(&path)))?;
        let text = String::from_utf8_lossy(&bytes);
        Ok(Some(format!(
            "export default {};",
            serde_json::to_string(&*text).unwrap()
        )))
    }

    pub(crate) fn load_text_module(&self, name: &str) -> Result<Option<String>, NativeError> {
        self.text_module_source(&ModuleName(name.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{ErrorKind, Val};
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Files(std::path::PathBuf);
    impl Files {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "bun-wasm-import-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(path.join("a")).unwrap();
            std::fs::create_dir_all(path.join("b")).unwrap();
            std::fs::write(path.join("a/page.html"), "\u{feff}#!data\nhéllo 🌍\n").unwrap();
            std::fs::write(path.join("b/page.html"), "different").unwrap();
            Self(path)
        }
        fn entry(&self, directory: &str) -> String {
            self.0
                .join(directory)
                .join("index.mjs")
                .to_string_lossy()
                .into_owned()
        }
    }
    impl Drop for Files {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn state() -> State {
        State::new(Vec::new(), Box::new(crate::PassthroughTranspiler))
    }

    #[test]
    fn tokens_resolve_per_physical_referrer_and_names_are_idempotent() {
        let files = Files::new();
        let state = state();
        let request = || ImportRequest {
            specifier: "./page.html",
            mode: ImportMode::Text,
        };
        let token = state.intern_import_request(request());
        assert_eq!(
            token.as_str(),
            state.intern_import_request(request()).as_str()
        );
        let a = state
            .resolve_module_name(token.as_str(), &files.entry("a"))
            .unwrap();
        let b = state
            .resolve_module_name(token.as_str(), &files.entry("b"))
            .unwrap();
        assert_ne!(a.as_str(), b.as_str());
        assert_eq!(
            a.as_str(),
            state
                .resolve_module_name(a.as_str(), &files.entry("b"))
                .unwrap()
                .as_str()
        );
        let alias = state
            .resolve_import(
                ImportRequest {
                    specifier: "../a/page.html",
                    mode: ImportMode::Text,
                },
                &files.entry("b"),
            )
            .unwrap();
        assert_eq!(a.as_str(), alias.as_str());
        let ordinary = state
            .resolve_module_name("./page.html", &files.entry("a"))
            .unwrap();
        assert_ne!(ordinary.as_str(), a.as_str());
        assert_eq!(state.module_path(a.as_str()), ordinary.as_str());
    }

    #[test]
    fn text_bypasses_default_source_cache_and_preserves_file_data() {
        let files = Files::new();
        let state = state();
        let name = state
            .resolve_import(
                ImportRequest {
                    specifier: "./page.html",
                    mode: ImportMode::Text,
                },
                &files.entry("a"),
            )
            .unwrap();
        let physical = state.module_path(name.as_str());
        assert_eq!(
            state.load_source(&physical).unwrap().1,
            modules::Format::Html
        );
        let (source, format) = state.load_source(name.as_str()).unwrap();
        assert_eq!(format, modules::Format::Esm);
        assert_eq!(
            &*source,
            format!(
                "export default {};",
                serde_json::to_string("\u{feff}#!data\nhéllo 🌍\n").unwrap()
            )
        );
        assert_eq!(
            state.load_source(&physical).unwrap().1,
            modules::Format::Html
        );
    }

    #[test]
    fn resolution_errors_keep_original_request_and_physical_referrer() {
        let files = Files::new();
        let state = state();
        let from = files.entry("a");
        let token = state.intern_import_request(ImportRequest {
            specifier: "./absent.html",
            mode: ImportMode::Text,
        });
        let error = state
            .resolve_module_name(token.as_str(), &from)
            .err()
            .unwrap();
        assert_eq!(error.name.as_deref(), Some("ResolveMessage"));
        for (key, value) in [
            ("code", "ERR_MODULE_NOT_FOUND"),
            ("specifier", "./absent.html"),
            ("referrer", &from),
        ] {
            assert!(error.props.contains(&(key.to_owned(), Val::from(value))));
        }
        assert_eq!(
            state
                .resolve_import(
                    ImportRequest {
                        specifier: "node:fs",
                        mode: ImportMode::Text
                    },
                    &from
                )
                .err()
                .unwrap()
                .kind,
            ErrorKind::TypeError
        );
        assert!(
            state
                .resolve_module_name("bunwasm:request:unknown", &from)
                .is_err()
        );
        assert!(
            state
                .resolve_module_name("bunwasm:text:unknown", &from)
                .is_err()
        );
    }
}
