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
//!   f: function* __bunwasm_cjs__(__bunwasm_m) { "use strict";
//!     __bunwasm_m.l({name: () => local});
//!     yield; const ns0 = __bunwasm_m.n[0], star = __bunwasm_m.ns(1); yield; <body> }})
//! ```
//!
//! The first `next()` registers the export getters, the second binds the
//! dependencies' binding views (named imports) and namespace objects
//! (`import * as`), and the rest is evaluation; every later `yield` is a
//! top-level `await`. The record is parsed in `with_bunwasm_register_parse`
//! mode (patch 0020), so module-level `this` and literal expressions stay as
//! written, and the body runs without a receiver. `record_fixup` reads a
//! module's global `arguments` through the loader. In module form the record
//! is `export default (…)`. `crates/bunwasm-runtime/src/js/esm_loader.ts` links
//! and evaluates the records.

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
    /// Header bindings of dependency namespaces: (printed name, request, `import * as`).
    /// Named imports read the loader's binding view (`n[request]`); star imports get the
    /// module namespace object (`ns(request)`, created on first use).
    namespaces: Vec<(String, u32, bool)>,
    /// The printed name of an anonymous `export default function`, which step 1 replaces
    /// with the function itself (see [`export_default`]).
    default_function: Option<String>,
    has_tla: bool,
    /// `import * as ns` bindings and their import records, so `export { ns }`
    /// re-exports the namespace.
    star_imports: Vec<(Ref, u32)>,
    /// Default imports are absent from Bun's non-bundling `named_imports` map.
    default_imports: Vec<(Ref, u32)>,
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
            B::B::BArray(array) => array
                .items
                .iter()
                .for_each(|item| self.export_binding(ast, item.binding)),
            B::B::BObject(object) => object
                .properties
                .iter()
                .for_each(|item| self.export_binding(ast, item.value)),
        }
    }

    fn export_local(&mut self, ast: &js_ast::Ast<'_>, alias: &str, r: Ref) {
        if let Some(&(_, record)) = self.star_imports.iter().find(|(star, _)| *star == r) {
            let request = self.request(ast, record);
            self.indirect
                .push((alias.to_owned(), request, "*".to_owned()));
            return;
        }
        if let Some(&(_, record)) = self.default_imports.iter().find(|(local, _)| *local == r) {
            let request = self.request(ast, record);
            self.indirect
                .push((alias.to_owned(), request, "default".to_owned()));
            return;
        }
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
    let statements = ast.parts.iter().flat_map(|part| part.stmts.slice());
    for stmt in statements {
        record_import_bindings(&mut module, *stmt);
    }
    rename_global_arguments(ast, arena);
    for part in 0..ast.parts.len() {
        let stmts = ast.parts[part].stmts.slice_mut();
        for stmt in stmts.iter_mut() {
            *stmt = rewrite(&mut module, ast, arena, *stmt);
        }
    }
    module
}

/// A module's `arguments` is the global binding, but a record body runs in a generator,
/// whose own `arguments` would shadow it. The unbound name prints as a placeholder that
/// `record_fixup` turns into a global-scope read.
fn rename_global_arguments(ast: &mut js_ast::Ast<'_>, arena: &Arena) {
    let unbound = ast.symbols.iter().position(|symbol| {
        symbol.kind == js_ast::symbol::Kind::Unbound && symbol.original_name.slice() == b"arguments"
    });
    let Some(index) = unbound else { return };
    let name: &[u8] = arena.alloc_slice_copy(crate::record_fixup::ARGUMENTS.as_bytes());
    ast.symbols[index].original_name = js_ast::StoreStr::new(name);
}

fn record_import_bindings(module: &mut Module, stmt: Stmt) {
    let StmtData::SImport(st) = stmt.data else {
        return;
    };
    if let Some(default) = st.default_name {
        module
            .default_imports
            .push((default.ref_, st.import_record_index));
    }
    if st.star_name_loc.is_empty() {
        return;
    }
    module
        .star_imports
        .push((st.namespace_ref, st.import_record_index));
}

fn export_from(module: &mut Module, ast: &js_ast::Ast<'_>, st: &S::ExportFrom) -> Stmt {
    let request = module.request(ast, st.import_record_index);
    for item in st.items.iter() {
        module.indirect.push((
            text(item.alias.slice()),
            request,
            text(item.original_name.slice()),
        ));
    }
    Stmt::empty()
}

fn export_star(module: &mut Module, ast: &js_ast::Ast<'_>, st: &S::ExportStar) -> Stmt {
    let request = module.request(ast, st.import_record_index);
    match &st.alias {
        Some(alias) => {
            module
                .indirect
                .push((text(alias.original_name.slice()), request, "*".to_owned()))
        }
        None => module.stars.push(request),
    }
    Stmt::empty()
}

fn export_clause(module: &mut Module, ast: &js_ast::Ast<'_>, st: &S::ExportClause) -> Stmt {
    for item in st.items.iter() {
        module.export_local(ast, &text(item.alias.slice()), item.name.ref_);
    }
    Stmt::empty()
}

fn export_declarations(module: &mut Module, ast: &js_ast::Ast<'_>, st: &mut S::Local) {
    st.is_export = false;
    for decl in st.decls.iter() {
        module.export_binding(ast, decl.binding);
    }
}

fn export_named(module: &mut Module, ast: &js_ast::Ast<'_>, name: Option<Ref>) {
    let Some(name) = name else { return };
    let name = Module::name_of(ast, name);
    module.locals.push((name.clone(), name));
}

fn rewrite(module: &mut Module, ast: &mut js_ast::Ast<'_>, arena: &Arena, stmt: Stmt) -> Stmt {
    match stmt.data {
        StmtData::SImport(st) => {
            import(module, ast, arena, &st);
            Stmt::empty()
        }
        StmtData::SExportFrom(st) => export_from(module, ast, &st),
        StmtData::SExportStar(st) => export_star(module, ast, &st),
        StmtData::SExportClause(st) => export_clause(module, ast, &st),
        StmtData::SLocal(mut st) if st.is_export => {
            export_declarations(module, ast, &mut st);
            stmt
        }
        StmtData::SFunction(mut st) if st.func.flags.contains(js_ast::G::FnFlags::IsExport) => {
            st.func.flags.remove(js_ast::G::FnFlags::IsExport);
            export_named(module, ast, st.func.name.map(|name| name.ref_));
            stmt
        }
        StmtData::SClass(mut st) if st.is_export => {
            st.is_export = false;
            export_named(module, ast, st.class.class_name.map(|name| name.ref_));
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
        .push((Module::name_of(ast, st.namespace_ref), request, star));
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
    let local = Module::name_of(ast, default.ref_);
    // The parser names an anonymous default function or class after a generated symbol.
    let generated =
        ast.symbols[default.ref_.inner_index() as usize].kind == js_ast::symbol::Kind::Other;
    let value = match st.value {
        StmtOrExpr::Stmt(inner) if generated => {
            if let Some(stmt) = anonymous_default_function(arena, inner, default) {
                module.default_function = Some(local.clone());
                module.locals.push(("default".to_owned(), local));
                return stmt;
            }
            let Some(class) = anonymous_default_class(arena, inner) else {
                let name = default_statement_name(inner, default);
                module
                    .locals
                    .push(("default".to_owned(), Module::name_of(ast, name)));
                return inner;
            };
            class
        }
        StmtOrExpr::Stmt(inner) => {
            let name = default_statement_name(inner, default);
            module
                .locals
                .push(("default".to_owned(), Module::name_of(ast, name)));
            return inner;
        }
        StmtOrExpr::Expr(value) if value.is_anonymous_named() => {
            named_default(arena, value, stmt.loc)
        }
        StmtOrExpr::Expr(value) => value,
    };
    module.locals.push(("default".to_owned(), local));
    const_declaration(arena, default.ref_, value, stmt.loc)
}

fn const_declaration(arena: &Arena, local: Ref, value: js_ast::Expr, loc: js_ast::Loc) -> Stmt {
    let mut decls = bun_alloc::AstAlloc::vec();
    decls.push(js_ast::G::Decl {
        binding: Binding::alloc(arena, B::Identifier { r#ref: local }, loc),
        value: Some(value),
    });
    Stmt::alloc(
        S::Local {
            kind: js_ast::LocalKind::KConst,
            decls,
            ..Default::default()
        },
        loc,
    )
}

/// `({ default: value }).default`: the anonymous function or class gets the name
/// `"default"` through NamedEvaluation, as `export default` gives it natively.
fn named_default(arena: &Arena, value: js_ast::Expr, loc: js_ast::Loc) -> js_ast::Expr {
    let key: &[u8] = b"default";
    let mut properties = bun_alloc::AstAlloc::vec();
    properties.push(js_ast::G::Property {
        key: Some(js_ast::Expr::allocate(
            arena,
            js_ast::E::String::init(key),
            loc,
        )),
        value: Some(value),
        ..Default::default()
    });
    let object = js_ast::Expr::allocate(
        arena,
        js_ast::E::Object {
            properties,
            ..Default::default()
        },
        loc,
    );
    js_ast::Expr::allocate(
        arena,
        js_ast::E::Dot {
            target: object,
            name: js_ast::StoreStr::new(key),
            name_loc: loc,
            ..Default::default()
        },
        loc,
    )
}

/// `export default function () {}` must exist before any module evaluates (a cycle can call
/// it first), be named `"default"`, and print as the anonymous function it is. The local
/// becomes a hoisted function that returns the anonymous one, and step 1 of the record
/// replaces the local with that result.
fn anonymous_default_function(arena: &Arena, inner: Stmt, default: js_ast::LocRef) -> Option<Stmt> {
    let StmtData::SFunction(mut declaration) = inner.data else {
        return None;
    };
    let mut anonymous = std::mem::take(&mut declaration.func);
    anonymous.name = None;
    let value = js_ast::Expr::allocate(arena, js_ast::E::Function { func: anonymous }, inner.loc);
    let body =
        js_ast::G::FnBody::init_return_expr(arena, named_default(arena, value, inner.loc)).ok()?;
    declaration.func = js_ast::G::Fn {
        name: Some(default),
        body,
        ..Default::default()
    };
    Some(inner)
}

/// `export default class {}`: a lexical binding that NamedEvaluation names `"default"`, so
/// static blocks and field initializers already see that name.
fn anonymous_default_class(arena: &Arena, inner: Stmt) -> Option<js_ast::Expr> {
    let StmtData::SClass(mut declaration) = inner.data else {
        return None;
    };
    let mut class = std::mem::take(&mut declaration.class);
    class.class_name = None;
    let value = js_ast::Expr::allocate(arena, class, inner.loc);
    Some(named_default(arena, value, inner.loc))
}

fn default_statement_name(inner: Stmt, default: js_ast::LocRef) -> Ref {
    match inner.data {
        StmtData::SClass(mut class) => class.class.class_name.get_or_insert(default).ref_,
        StmtData::SFunction(mut func) => func.func.name.get_or_insert(default).ref_,
        _ => default.ref_,
    }
}

fn json(s: &str) -> String {
    serde_json::to_string(s).expect("strings serialize")
}

/// The registration record for `module` around its printed `body`. The
/// header stays on line 1 so the body keeps its line numbers.
///
/// `as_module` prints it as an ES module that default-exports the record, for a host that
/// evaluates records as modules so their functions keep a script URL in stack traces. The
/// body generator is named after the runtime's top-level frame marker (`__bunwasm_cjs__`,
/// see `bootstrap.js` `formatCallSite` and `inspect.js`), so module code prints as top level.
pub fn assemble(module: &Module, body: &str, as_module: bool) -> String {
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
        .map(|(name, r, star)| match star {
            true => format!("{name}=__bunwasm_m.ns({r})"),
            false => format!("{name}=__bunwasm_m.n[{r}]"),
        })
        .collect();
    let bind = if namespaces.is_empty() {
        String::new()
    } else {
        format!("const {};", namespaces.join(","))
    };
    let default_function = module
        .default_function
        .as_ref()
        .map_or_else(String::new, |local| format!("{local}={local}();"));
    format!(
        "{}({{r:[{}],i:[{}],x:[{}],s:[{}],a:{},f:function*__bunwasm_cjs__(__bunwasm_m){{\"use strict\";{default_function}__bunwasm_m.l({{{}}});yield;{bind}yield;{body}\n}}}})",
        if as_module { "export default " } else { "" },
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

    /// Bun's parser keeps process-wide state; one transpile at a time.
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn register_one(source: &str, path: &str) -> String {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        register(source, path, Loader::Js).unwrap().code
    }

    #[test]
    fn record_map_includes_the_header_column_offset() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let record = register(
            "export const n = 1;\nthrow new Error('mapped');\n",
            "/mapped.mjs",
            Loader::Js,
        )
        .unwrap();
        let first = bun_sourcemap::vlq::decode(record.mappings.as_bytes(), 0);
        assert_eq!(first.value as usize, record.code.find("const n").unwrap());
        assert!(record.mappings.contains(';'));
    }

    #[test]
    fn module_records_default_export_the_record_and_map_through_the_prefix() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let source = "export const n = 1;\nthrow new Error('mapped');\n";
        let record = crate::register_module(source, "/mapped.mjs", Loader::Js).unwrap();
        assert!(
            record.code.starts_with("export default ({r:[]"),
            "{}",
            record.code
        );
        assert!(
            record
                .code
                .contains("f:function*__bunwasm_cjs__(__bunwasm_m)"),
            "{}",
            record.code
        );
        let first = bun_sourcemap::vlq::decode(record.mappings.as_bytes(), 0);
        assert_eq!(first.value as usize, record.code.find("const n").unwrap());
        let script = register(source, "/mapped.mjs", Loader::Js).unwrap();
        assert_eq!(
            record.code.strip_prefix("export default "),
            Some(script.code.as_str())
        );
    }

    #[test]
    fn records_carry_imports_exports_and_await() {
        let source = "import d, { a as b } from './x.js';\nexport * from './y.js';\nexport { b as c };\nexport let n = await d();\nexport default function () { return b(); }\n";
        let record = register_one(source, "/m.js");
        assert!(
            record.starts_with(
                r#"({r:["./x.js","./y.js"],i:[[0,"default"],[0,"a"]],x:[["c",0,"a"]],s:[1],a:true,"#
            ),
            "{record}"
        );
        assert!(record.contains(r#""use strict";m_default=m_default();__bunwasm_m.l({"n":()=>n,"default":()=>m_default});yield;const __bunwasm_ns0_0=__bunwasm_m.n[0];yield;"#), "{record}");
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
    fn anonymous_defaults_are_named_default_without_a_printed_name() {
        let function = register_one("export default function () { return 1; }\n", "/f.mjs");
        assert!(function.contains("f_default=f_default();"), "{function}");
        assert!(function.contains("function f_default() {"), "{function}");
        assert!(function.contains("default: function() {"), "{function}");
        let generator = register_one("export default async function* () { yield 1; }\n", "/g.mjs");
        assert!(
            generator.contains("default: async function* () {"),
            "{generator}"
        );
        let class = register_one("export default class { static n = this.name; }\n", "/c.mjs");
        assert!(class.contains("const c_default = {"), "{class}");
        assert!(class.contains("default: class {"), "{class}");
        assert!(!class.contains("c_default=c_default()"), "{class}");
        let arrow = register_one("export default () => 1;\n", "/a.mjs");
        assert!(arrow.contains("default: () => 1"), "{arrow}");
        let named = register_one("export default function named() {}\n", "/n.mjs");
        assert!(named.contains("function named()"), "{named}");
        assert!(named.contains(r#""default":()=>named"#), "{named}");
        assert!(!named.contains("named=named()"), "{named}");
        let value = register_one("export default 1 + 2;\n", "/v.mjs");
        assert!(value.contains("const v_default = 1 + 2;"), "{value}");
    }

    /// Functions keep their structure in `Function.prototype.toString`: only the printer's
    /// formatting, comments and literal spellings may differ from the file.
    #[test]
    fn records_keep_expression_structure() {
        let source = "export function f(x) { if (false) return 1 + 2; return 'a' + 'b' + x?.y + (void 0) + typeof 1 + (1 === 1); }\n";
        let record = register_one(source, "/s.mjs");
        for kept in [
            "if (false)",
            "1 + 2",
            "\"a\" + \"b\"",
            "x?.y",
            "typeof 1",
            "1 === 1",
        ] {
            assert!(record.contains(kept), "{kept}: {record}");
        }
    }

    #[test]
    fn star_imports_bind_the_namespace_slot_and_named_imports_the_binding_view() {
        let record = register_one(
            "import * as ns from './x.js';\nimport { a } from './x.js';\nns.a(a);\n",
            "/m.mjs",
        );
        assert!(
            record.contains("const ns=__bunwasm_m.ns(0),__bunwasm_ns0_1=__bunwasm_m.n[0];"),
            "{record}"
        );
    }

    #[test]
    fn dead_code_elimination_is_off_for_records_and_restored() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let eliminate = || {
            crate::with_state(|state| Ok(state.transpiler.options.dead_code_elimination)).unwrap()
        };
        let before = eliminate();
        let record = register("typeof x;\nlet x = 1;\n", "/tdz.mjs", Loader::Js)
            .unwrap()
            .code;
        assert!(record.contains("typeof x;"), "{record}");
        assert_eq!(eliminate(), before);
        assert!(register("export const = ;\n", "/broken.mjs", Loader::Js).is_err());
        assert_eq!(eliminate(), before);
    }

    /// The record body runs as a generator called without a receiver, so module-level and
    /// lexical `this` are kept as written and evaluate to `undefined`, folded forms included.
    #[test]
    fn module_this_is_kept_for_the_generator() {
        let record = register_one(
            "export const t = this;\nconst f = () => [this, typeof this, this === undefined, this !== null];\nfunction g() { return this; }\nclass C { x = this; static { this.n = 1; } }\n",
            "/t.mjs",
        );
        assert!(record.contains("const t = this;"), "{record}");
        assert!(
            record.contains("[this, typeof this, this === undefined, this !== null]"),
            "{record}"
        );
        assert!(record.contains("return this;"), "{record}");
        assert!(record.contains("x = this;"), "{record}");
        assert!(!record.contains("\"object\""), "{record}");
        let script = register_one("console.log(this);\n", "/s.mjs");
        assert!(script.contains("console.log(this);"), "{script}");
    }

    const PREPARED: &str = "export const t = this;\nexport const s = typeof 1 + (1 === 1);\nexport default function (x: number) { return typeof this + x; }\nexport async function w() { await null; return this; }\n";

    /// The real record pipeline: the module loader's first pass (TypeScript, await hooks) under
    /// `use_module_records`, then the record pass over its output, as `module_record` runs them.
    #[test]
    fn prepared_sources_keep_this_and_literals_through_both_passes() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        crate::use_module_records();
        let first = crate::with_await_hooks(true, || {
            crate::transpile_with_source_map(PREPARED, "/p.ts", Loader::Ts, false)
        })
        .unwrap();
        assert!(first.code.contains("const t = this;"), "{}", first.code);
        assert!(first.code.contains("__bunwasm_resume"), "{}", first.code);
        let record = register(&first.code, "/p.ts", Loader::Js).unwrap().code;
        assert!(record.contains("const t = this;"), "{record}");
        assert!(record.contains("typeof 1 + (1 === 1)"), "{record}");
        assert!(record.contains("return typeof this + x;"), "{record}");
        assert!(record.contains("p_default=p_default();"), "{record}");
        assert_eq!(
            record.matches("__bunwasm_resume").count(),
            first.code.matches("__bunwasm_resume").count(),
            "{record}"
        );
    }

    #[test]
    fn prepared_anonymous_default_class_stays_anonymous() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        crate::use_module_records();
        let source = "export default class { static n: string = this.name; }\n";
        let first = crate::transpile_with_source_map(source, "/k.ts", Loader::Ts, false).unwrap();
        let record = register(&first.code, "/k.ts", Loader::Js).unwrap().code;
        assert!(
            record.contains("const k_default = {"),
            "{}\n{record}",
            first.code
        );
        assert!(
            record.contains("default: class {"),
            "{}\n{record}",
            first.code
        );
    }

    /// The record parse leaves ordinary transpiles as they were: before and after a record, after
    /// a failed record, and on threads that never chose records.
    #[test]
    fn record_parsing_does_not_leak_into_ordinary_transpiles() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let ordinary = || {
            crate::transpile_with_source_map(PREPARED, "/o.ts", Loader::Ts, false)
                .unwrap()
                .code
        };
        let before = ordinary();
        assert!(before.contains("\"numbertrue\""), "{before}");
        assert!(before.contains("function o_default(x)"), "{before}");
        assert!(!before.contains("const t = this;"), "{before}");
        register(PREPARED, "/o.mjs", Loader::Ts).unwrap();
        assert_eq!(ordinary(), before);
        assert!(register("export const = ;\n", "/broken.mjs", Loader::Js).is_err());
        assert_eq!(ordinary(), before);
        let public = |action| {
            crate::public_transpile(
                PREPARED.as_bytes(),
                r#"{"target":"bun","loader":"ts"}"#,
                action,
                "ts",
            )
            .unwrap()
        };
        let (scan, transform) = (public("scan"), public("transform"));
        assert!(transform.contains("numbertrue"), "{transform}");
        std::thread::spawn(crate::use_module_records)
            .join()
            .unwrap();
        register(PREPARED, "/o2.mjs", Loader::Ts).unwrap();
        assert_eq!(ordinary(), before);
        assert_eq!((public("scan"), public("transform")), (scan, transform));
    }

    #[test]
    fn assigning_module_arguments_is_a_parse_error() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        assert!(register("arguments = 1;\n", "/w.mjs", Loader::Js).is_err());
    }

    #[test]
    fn module_arguments_is_the_global_binding() {
        let record = register_one(
            "console.log(typeof arguments, arguments);\narguments.call(1);\nconst h = () => arguments;\nfunction g() { return arguments; }\n",
            "/args.mjs",
        );
        assert!(
            record.contains("console.log(__bunwasm_m.gt(), __bunwasm_m.ga());"),
            "{record}"
        );
        assert!(record.contains("__bunwasm_m.ga().call(1);"), "{record}");
        assert!(
            record.contains("const h = () => __bunwasm_m.ga();"),
            "{record}"
        );
        assert!(record.contains("return arguments;"), "{record}");
        assert!(!record.contains(crate::record_fixup::ARGUMENTS), "{record}");
    }

    /// V8 places `(0, ns.f)(x)` at its argument list and `f(x)` at its callee: the argument
    /// list maps to where the call starts in the module.
    #[test]
    fn imported_calls_map_their_argument_list_to_the_call() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let source = "import { test } from 'bun:test';\n  test('no body');\n";
        let record = register(source, "/c.mjs", Loader::Js).unwrap();
        let line = record.code.lines().next().unwrap();
        let list = line[..line.find(")(\"no body\")").unwrap() + 1]
            .encode_utf16()
            .count() as i64;
        let mut column = 0i64;
        let mut original = (0i64, 0i64);
        let mut found = None;
        for segment in record.mappings.split(';').next().unwrap().split(',') {
            let fields = crate::record_fixup::tests::decode_fields(segment);
            column += fields[0];
            original = (original.0 + fields[2], original.1 + fields[3]);
            found = found.or((column == list).then_some(original));
        }
        assert_eq!(found, Some((1, 2)), "{}", record.code);
    }

    #[test]
    fn fixups_keep_later_tokens_mapped() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let source = "export const a = [this, arguments, zz];\n";
        let record = register(source, "/map.mjs", Loader::Js).unwrap();
        let line = record.code.lines().next().unwrap();
        let generated = line[..line.find("zz").unwrap()].encode_utf16().count() as i64;
        let mut column = 0i64;
        let mut original = (0i64, 0i64);
        let mut found = None;
        for segment in record.mappings.split(';').next().unwrap().split(',') {
            let fields = crate::record_fixup::tests::decode_fields(segment);
            column += fields[0];
            original = (original.0 + fields[2], original.1 + fields[3]);
            found = found.or((column == generated).then_some(original));
        }
        assert_eq!(
            found,
            Some((0, source.find("zz").unwrap() as i64)),
            "{}",
            record.code
        );
    }

    #[test]
    fn default_import_reexport_uses_the_dependency_binding() {
        let source = "import EventEmitter from './index.cjs';\nexport { EventEmitter };\nexport default EventEmitter;\n";
        let record = register_one(source, "/index.mjs");
        assert!(
            record.contains(r#"x:[["EventEmitter",0,"default"]]"#),
            "{record}"
        );
        assert!(
            !record.contains(r#""EventEmitter":()=>EventEmitter"#),
            "{record}"
        );
        assert!(record.contains("= __bunwasm_ns0_0.default;"), "{record}");
    }

    #[test]
    fn default_import_reexports_are_order_independent_and_preserve_aliases() {
        let source =
            "export { value as renamed, value as default };\nimport value from './lib.mjs';\n";
        let record = register_one(source, "/forward.mjs");
        assert!(
            record.contains(r#"x:[["renamed",0,"default"],["default",0,"default"]]"#),
            "{record}"
        );
        assert!(record.contains("__bunwasm_m.l({});"), "{record}");
    }

    #[test]
    fn nested_await_meta_and_dynamic_import() {
        let source = "async function f() { await import('./z.js'); return import.meta.url; }\n";
        let record = register_one(source, "/m.js");
        assert!(record.contains("a:false,"), "{record}");
        assert!(
            record.contains("await __bunwasm_m.import(\"./z.js\")"),
            "{record}"
        );
        assert!(record.contains("return __bunwasm_m.meta.url"), "{record}");
    }

    #[test]
    fn import_meta_main_changes_only_in_record_mode() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let source = "console.log(import.meta.main, !import.meta.main);\nfunction nested() { return import.meta.main; }\n";
        let esm = crate::transpile(source, "/main.mjs", Loader::Js).unwrap();
        let cjs = crate::public_transpile(
            source.as_bytes(),
            r#"{"target":"node","loader":"js"}"#,
            "transform",
            "js",
        )
        .unwrap();
        assert!(esm.contains("import.meta.main"), "{esm}");
        assert!(cjs.contains("require.main"), "{cjs}");
        assert!(!esm.contains("__bunwasm_m"), "{esm}");
        assert!(!cjs.contains("__bunwasm_m"), "{cjs}");
        println!("ordinary esm: {esm}\nordinary cjs: {cjs}");
        let record = register(source, "/main.mjs", Loader::Js).unwrap().code;
        assert!(!record.contains("import.meta"), "{record}");
        assert_eq!(
            record.matches("__bunwasm_m.meta.main").count(),
            3,
            "{record}"
        );
        assert!(record.contains("!__bunwasm_m.meta.main"), "{record}");
    }

    /// tests/fixtures/esm-loader/*/records.json came from this transform
    /// (scripts/esm-loader-fixtures.ts); the loader tests run them.
    #[test]
    fn fixture_records_are_current() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/esm-loader");
        for case in std::fs::read_dir(&root).unwrap().flatten() {
            check_fixture_records(&case.path());
        }
    }

    fn check_fixture_records(case: &std::path::Path) {
        let records: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(case.join("records.json")).unwrap())
                .unwrap();
        for (name, code) in records["modules"].as_object().unwrap() {
            if !name.ends_with(".mjs") {
                continue;
            }
            let file = case.join(name.trim_start_matches('/'));
            let source = std::fs::read_to_string(&file).unwrap();
            let fresh = register_one(&source, file.to_str().unwrap());
            assert_eq!(
                code.as_str().unwrap(),
                fresh,
                "stale record for {}; rerun scripts/esm-loader-fixtures.ts",
                file.display()
            );
        }
    }
}
