//! ES modules as registration records, for engines without native ES modules.
//!
//! [`prepare`] rewrites a parsed module's top-level import and export
//! statements: imports leave the code (references to imported names print as
//! `namespace.name` through the symbol's namespace alias, so they stay live),
//! `export` keywords are stripped and the exported names become getters. The
//! printer, with `bun_js_printer::with_bunwasm_register`, prints top-level
//! `await` as `yield`, `import.meta` as `__bunwasm_m.meta` and `import()` as
//! `__bunwasm_m.import()`. [`assemble`] wraps the printed body:
//!
//! ```js
//! ({r: [specifiers], i: [[request, name]], x: [[export, request, import]],
//!   s: [star requests], a: hasTopLevelAwait,
//!   f: function* (__bunwasm_m) { "use strict"; __bunwasm_m.l({name: () => local});
//!     yield; var ns0 = __bunwasm_m.n[0]; yield; <body> }})
//! ```
//!
//! The first `next()` registers the export getters, the second binds the
//! dependencies' namespace objects, and the rest is evaluation; every later
//! `yield` is a top-level `await`. `crates/bunwasm-runtime/src/js/esm_loader.ts`
//! links and evaluates the records.

use std::collections::HashMap;

use bun_alloc::Arena;
use bun_ast::{self as js_ast, B, Binding, Ref, S, Stmt, StmtData, StmtOrExpr};

/// What [`prepare`] learned about the module's imports and exports.
#[derive(Default)]
pub struct Module {
    requests: Vec<String>,
    request_of_record: HashMap<u32, u32>,
    /// Named imports checked at link time: (request, imported name).
    imports: Vec<(u32, String)>,
    /// Re-exports: (export name, request, imported name or `*`).
    indirect: Vec<(String, u32, String)>,
    stars: Vec<u32>,
    /// Local exports: (export name, local binding as printed).
    locals: Vec<(String, String)>,
    /// Header bindings of dependency namespaces: (printed name, request).
    namespaces: Vec<(String, u32)>,
    has_tla: bool,
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

impl Module {
    fn request(&mut self, ast: &js_ast::Ast<'_>, record: u32) -> u32 {
        if let Some(&request) = self.request_of_record.get(&record) {
            return request;
        }
        let specifier = text(ast.import_records[record as usize].path.text);
        let request = match self.requests.iter().position(|s| *s == specifier) {
            Some(i) => i as u32,
            None => {
                self.requests.push(specifier);
                (self.requests.len() - 1) as u32
            }
        };
        self.request_of_record.insert(record, request);
        request
    }

    fn name_of(ast: &js_ast::Ast<'_>, r: Ref) -> String {
        text(ast.symbols[r.inner_index() as usize].original_name.slice())
    }

    fn export_binding(&mut self, ast: &js_ast::Ast<'_>, binding: Binding) {
        match binding.data {
            B::B::BMissing(_) => {}
            B::B::BIdentifier(id) => {
                let name = Self::name_of(ast, id.r#ref);
                self.locals.push((name.clone(), name));
            }
            B::B::BArray(array) => {
                for item in array.items.iter() {
                    self.export_binding(ast, item.binding);
                }
            }
            B::B::BObject(object) => {
                for item in object.properties.iter() {
                    self.export_binding(ast, item.value);
                }
            }
        }
    }

    fn export_local(&mut self, ast: &js_ast::Ast<'_>, alias: &str, r: Ref) {
        let Some(import) = ast.named_imports.get(&r) else {
            self.locals.push((alias.to_owned(), Self::name_of(ast, r)));
            return;
        };
        let request = self.request(ast, import.import_record_index);
        let imported = match (&import.alias, import.alias_is_star) {
            (_, true) | (None, _) => "*".to_owned(),
            (Some(name), false) => text(name.slice()),
        };
        self.indirect.push((alias.to_owned(), request, imported));
    }
}

fn rename(ast: &mut js_ast::Ast<'_>, arena: &Arena, r: Ref, name: &str) {
    let name: &[u8] = arena.alloc_slice_copy(name.as_bytes());
    ast.symbols[r.inner_index() as usize].original_name = js_ast::StoreStr::new(name);
}

fn alias_to_namespace(
    ast: &mut js_ast::Ast<'_>,
    local: Ref,
    namespace: Ref,
    alias: &[u8],
    record: u32,
) {
    ast.symbols[local.inner_index() as usize].namespace_alias =
        Some(bun_alloc::ast_box(js_ast::G::NamespaceAlias {
            namespace_ref: namespace,
            alias: js_ast::StoreStr::new(alias),
            was_originally_property_access: true,
            import_record_index: record,
        }));
}

/// Rewrite the module's top-level statements in place (see the module docs).
pub fn prepare(ast: &mut js_ast::Ast<'_>, arena: &Arena) -> Module {
    let mut module = Module {
        has_tla: ast.top_level_await_keyword.len > 0,
        ..Module::default()
    };
    for part in 0..ast.parts.len() {
        let stmts = ast.parts[part].stmts.slice_mut();
        for stmt in stmts.iter_mut() {
            *stmt = rewrite(&mut module, ast, arena, *stmt);
        }
    }
    module
}

fn rewrite(module: &mut Module, ast: &mut js_ast::Ast<'_>, arena: &Arena, stmt: Stmt) -> Stmt {
    match stmt.data {
        StmtData::SImport(st) => {
            import(module, ast, arena, &st);
            Stmt::empty()
        }
        StmtData::SExportFrom(st) => {
            let request = module.request(ast, st.import_record_index);
            for item in st.items.iter() {
                let imported = text(item.original_name.slice());
                module
                    .indirect
                    .push((text(item.alias.slice()), request, imported));
            }
            Stmt::empty()
        }
        StmtData::SExportStar(st) => {
            let request = module.request(ast, st.import_record_index);
            match &st.alias {
                Some(alias) => module.indirect.push((
                    text(alias.original_name.slice()),
                    request,
                    "*".to_owned(),
                )),
                None => module.stars.push(request),
            }
            Stmt::empty()
        }
        StmtData::SExportClause(st) => {
            for item in st.items.iter() {
                module.export_local(ast, &text(item.alias.slice()), item.name.ref_);
            }
            Stmt::empty()
        }
        StmtData::SLocal(mut st) if st.is_export => {
            st.is_export = false;
            for decl in st.decls.iter() {
                module.export_binding(ast, decl.binding);
            }
            stmt
        }
        StmtData::SFunction(mut st) if st.func.flags.contains(js_ast::G::FnFlags::IsExport) => {
            st.func.flags.remove(js_ast::G::FnFlags::IsExport);
            if let Some(name) = st.func.name {
                let name = Module::name_of(ast, name.ref_);
                module.locals.push((name.clone(), name));
            }
            stmt
        }
        StmtData::SClass(mut st) if st.is_export => {
            st.is_export = false;
            if let Some(name) = st.class.class_name {
                let name = Module::name_of(ast, name.ref_);
                module.locals.push((name.clone(), name));
            }
            stmt
        }
        StmtData::SExportDefault(st) => export_default(module, ast, arena, stmt, &st),
        _ => stmt,
    }
}

fn import(module: &mut Module, ast: &mut js_ast::Ast<'_>, arena: &Arena, st: &S::Import) {
    let record = st.import_record_index;
    let request = module.request(ast, record);
    let star = !st.star_name_loc.is_empty();
    if st.default_name.is_none() && st.items.is_empty() && !star {
        return;
    }
    if !star {
        let name = format!("__bunwasm_ns{}_{}", request, module.namespaces.len());
        rename(ast, arena, st.namespace_ref, &name);
    }
    module
        .namespaces
        .push((Module::name_of(ast, st.namespace_ref), request));
    if let Some(default) = st.default_name {
        alias_to_namespace(ast, default.ref_, st.namespace_ref, b"default", record);
        module.imports.push((request, "default".to_owned()));
    }
    for item in st.items.iter() {
        let alias: &[u8] = arena.alloc_slice_copy(item.alias.slice());
        alias_to_namespace(ast, item.name.ref_, st.namespace_ref, alias, record);
        module.imports.push((request, text(alias)));
    }
}

fn export_default(
    module: &mut Module,
    ast: &mut js_ast::Ast<'_>,
    arena: &Arena,
    stmt: Stmt,
    st: &S::ExportDefault,
) -> Stmt {
    let default = st.default_name;
    match st.value {
        StmtOrExpr::Stmt(inner) => {
            let name = match inner.data {
                StmtData::SClass(mut class) => class.class.class_name.get_or_insert(default).ref_,
                StmtData::SFunction(mut func) => func.func.name.get_or_insert(default).ref_,
                _ => default.ref_,
            };
            if name == default.ref_ {
                rename(ast, arena, name, "__bunwasm_default");
            }
            module
                .locals
                .push(("default".to_owned(), Module::name_of(ast, name)));
            inner
        }
        StmtOrExpr::Expr(value) => {
            rename(ast, arena, default.ref_, "__bunwasm_default");
            module
                .locals
                .push(("default".to_owned(), "__bunwasm_default".to_owned()));
            let mut decls = bun_alloc::AstAlloc::vec();
            decls.push(js_ast::G::Decl {
                binding: Binding::alloc(
                    arena,
                    B::Identifier {
                        r#ref: default.ref_,
                    },
                    stmt.loc,
                ),
                value: Some(value),
            });
            Stmt::alloc(
                S::Local {
                    kind: js_ast::LocalKind::KConst,
                    decls,
                    ..Default::default()
                },
                stmt.loc,
            )
        }
    }
}

fn json(s: &str) -> String {
    serde_json::to_string(s).expect("strings serialize")
}

/// The registration record for `module` around its printed `body`. The
/// header stays on line 1 so the body keeps its line numbers.
pub fn assemble(module: &Module, body: &str) -> String {
    let requests: Vec<String> = module.requests.iter().map(|s| json(s)).collect();
    let imports: Vec<String> = module
        .imports
        .iter()
        .map(|(r, n)| format!("[{r},{}]", json(n)))
        .collect();
    let indirect: Vec<String> = module
        .indirect
        .iter()
        .map(|(e, r, i)| format!("[{},{r},{}]", json(e), json(i)))
        .collect();
    let stars: Vec<String> = module.stars.iter().map(u32::to_string).collect();
    let getters: Vec<String> = module
        .locals
        .iter()
        .map(|(name, local)| format!("{}:()=>{local}", json(name)))
        .collect();
    let namespaces: Vec<String> = module
        .namespaces
        .iter()
        .map(|(name, r)| format!("{name}=__bunwasm_m.n[{r}]"))
        .collect();
    let bind = if namespaces.is_empty() {
        String::new()
    } else {
        format!("var {};", namespaces.join(","))
    };
    format!(
        "({{r:[{}],i:[{}],x:[{}],s:[{}],a:{},f:function*(__bunwasm_m){{\"use strict\";__bunwasm_m.l({{{}}});yield;{bind}yield;{body}\n}}}})",
        requests.join(","),
        imports.join(","),
        indirect.join(","),
        stars.join(","),
        module.has_tla,
        getters.join(","),
    )
}

#[cfg(test)]
mod tests {
    use crate::{Loader, register};

    #[test]
    fn records_carry_imports_exports_and_await() {
        let source = "import d, { a as b } from './x.js';\nexport * from './y.js';\nexport { b as c };\nexport let n = await d();\nexport default function () { return b(); }\n";
        let record = register(source, "/m.js", Loader::Js).unwrap();
        assert!(
            record.starts_with(
                r#"({r:["./x.js","./y.js"],i:[[0,"default"],[0,"a"]],x:[["c",0,"a"]],s:[1],a:true,"#
            ),
            "{record}"
        );
        assert!(record.contains(r#"__bunwasm_m.l({"n":()=>n,"default":()=>__bunwasm_default});yield;var __bunwasm_ns0_0=__bunwasm_m.n[0];yield;"#), "{record}");
        assert!(
            record.contains("(yield (0, __bunwasm_ns0_0.default)())"),
            "{record}"
        );
        assert!(
            record.contains("return (0, __bunwasm_ns0_0.a)();"),
            "{record}"
        );
    }

    #[test]
    fn nested_await_meta_and_dynamic_import() {
        let source = "async function f() { await import('./z.js'); return import.meta.url; }\n";
        let record = register(source, "/m.js", Loader::Js).unwrap();
        assert!(record.contains("a:false,"), "{record}");
        assert!(
            record.contains("await __bunwasm_m.import(\"./z.js\")"),
            "{record}"
        );
        assert!(record.contains("return __bunwasm_m.meta.url"), "{record}");
    }

    /// tests/fixtures/esm-loader/*/records.json came from this transform
    /// (scripts/esm-loader-fixtures.ts); the loader tests run them.
    #[test]
    fn fixture_records_are_current() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/esm-loader");
        for case in std::fs::read_dir(&root).unwrap().flatten() {
            let records: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(case.path().join("records.json")).unwrap(),
            )
            .unwrap();
            for (name, code) in records["modules"].as_object().unwrap() {
                let file = case.path().join(name.trim_start_matches('/'));
                if !name.ends_with(".mjs") {
                    continue;
                }
                let source = std::fs::read_to_string(&file).unwrap();
                let fresh = register(&source, file.to_str().unwrap(), Loader::Js).unwrap();
                assert_eq!(
                    code.as_str().unwrap(),
                    fresh,
                    "stale record for {}; rerun scripts/esm-loader-fixtures.ts",
                    file.display()
                );
            }
        }
    }
}
