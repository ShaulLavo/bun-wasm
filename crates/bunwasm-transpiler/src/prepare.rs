//! Insertion-only preparation of runtime-built JavaScript.
use bun_js_parser::BunwasmSplice as Span;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const PREPARE_VERSION: u32 = 6;

// Shared with source_prepare.ts. Every insertion is newline-free.
pub const TEXT: &[&str] = &[
    "__bunwasm_resume(__bunwasm_capture(), ",
    ")",
    "__bunwasm_resumed(",
    "__bunwasm_id(",
    ", __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0)",
    "let __bunwasm_s = 0; ",
    "__bunwasm_caught(__bunwasm_s, __bunwasm_s = 0); ",
    ", __bunwasm_s = __bunwasm_capture()), __bunwasm_s = 0)",
    "{ let __bunwasm_c; try { ",
    "__bunwasm_c = __bunwasm_iterate(",
    "try { __bunwasm_entered(__bunwasm_c); ",
    "} finally { __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0); } ",
    " } finally { __bunwasm_exited(__bunwasm_c); } }",
    "{ try { __bunwasm_entered(__bunwasm_c); ",
    "} finally { __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0); } }",
    "__bunwasm_evalArg(eval, ",
    "__bunwasm_dynamicImport",
    ", \"eval-indirect\")",
    "__bunwasm_evalSpread(eval, ",
    "return ",
];

/// Goal "vm-context": `TEXT[19]` before the final top-level expression statement.
const COMPLETION: usize = 19;
// Goal "vm-context" kinds past `TEXT`, whose text names the hygienic scope parameter `s`
// (source_prepare.ts `scoped`).
/// `${s}.`
const SCOPE_READ: usize = 20;
/// `${s}_typeof.`
const SCOPE_TYPEOF: usize = 21;
/// `(0, ${s}.`, closed by kind 1 after the name.
const SCOPE_CALL: usize = 22;
/// Replaces the name with a computed data key: `["${name}"]: ${s}.${name}`.
const SCOPE_SHORTHAND: usize = 23;

fn inserted_len(kind: usize, deleted: usize, scope: &str) -> usize {
    match kind {
        SCOPE_READ => scope.len() + 1,
        SCOPE_TYPEOF => scope.len() + "_typeof.".len(),
        SCOPE_CALL => scope.len() + "(0, .".len(),
        SCOPE_SHORTHAND => deleted + scope.len() + "[\"\"]: .".len(),
        _ => TEXT[kind].len() - deleted,
    }
}

#[derive(Default)]
struct Body {
    start: usize,
    end: usize,
    asynchronous: bool,
    suspension_handlers: bool,
    prepared: bool,
}

#[derive(Clone, Default)]
struct Edits(Vec<(usize, usize, usize, i64)>);
impl Edits {
    fn at(&mut self, at: usize, kind: usize) {
        self.0.push((at, 0, kind, i64::MIN + kind as i64));
    }
    fn open(&mut self, at: usize, end: usize, kind: usize) {
        let rank = match kind {
            15 => 0,
            3 => 1,
            8 => 2,
            _ => 3,
        };
        self.0.push((at, 0, kind, -(end as i64) * 32 + rank));
    }
    fn close(&mut self, at: usize, start: usize, kind: usize) {
        self.0.push((at, 0, kind, -(start as i64) * 32));
    }
}

fn owner(bodies: &[Body], at: usize) -> Option<usize> {
    bodies
        .iter()
        .enumerate()
        .filter(|(_, body)| body.start <= at && at < body.end)
        .min_by_key(|(_, body)| body.end - body.start)
        .map(|(index, _)| index)
}

fn already_hooked(source: &str, at: usize) -> bool {
    let before = source[..at].trim_end();
    before.ends_with("__bunwasm_resume(__bunwasm_capture(),")
        || before.ends_with("__bunwasm_resumed(")
        || before.ends_with("__bunwasm_id(")
}

fn await_edits(edits: &mut Edits, source: &str, start: usize, operand: usize, end: usize, s: bool) {
    if already_hooked(source, start) {
        return;
    }
    edits.open(start, end, if s { 2 } else { 0 });
    if s {
        edits.open(operand, end, 3);
    }
    edits.close(end, start, if s { 4 } else { 1 });
}

fn collect(source: &str, spans: &[Span], imports: &[usize]) -> Edits {
    let mut bodies: Vec<Body> = spans
        .iter()
        .filter_map(|span| match span {
            Span::Function {
                start,
                end,
                asynchronous,
            } => Some(Body {
                start: *start,
                end: *end,
                asynchronous: *asynchronous,
                ..Default::default()
            }),
            _ => None,
        })
        .collect();
    for at in spans.iter().filter_map(|span| match span {
        Span::Try(at) | Span::Loop { start: at, .. } => Some(*at),
        _ => None,
    }) {
        if let Some(index) = owner(&bodies, at) {
            bodies[index].suspension_handlers = bodies[index].asynchronous;
        }
    }
    let prologues: BTreeMap<usize, usize> = spans
        .iter()
        .filter_map(|span| match span {
            Span::Prologue { start, end } => Some((*start, *end)),
            _ => None,
        })
        .collect();
    for body in &mut bodies {
        let at = *prologues.get(&body.start).unwrap_or(&body.start);
        body.prepared = source[at..body.end]
            .trim_start()
            .starts_with("let __bunwasm_s = 0;");
    }
    let mut edits = Edits::default();
    for body in bodies.iter().filter(|body| body.suspension_handlers) {
        // Already prepared functions retain their own activation local.
        if body.prepared {
            continue;
        }
        edits.at(*prologues.get(&body.start).unwrap_or(&body.start), 5);
    }
    for span in spans {
        collect_span(&mut edits, source, spans, &bodies, span);
    }
    edits.0.extend(imports.iter().map(|at| (*at, 6, 16, 0)));
    edits
}

fn collect_span(edits: &mut Edits, source: &str, spans: &[Span], bodies: &[Body], span: &Span) {
    let at = match *span {
        Span::Await { start, .. }
        | Span::Yield { start, .. }
        | Span::Loop { start, .. }
        | Span::Eval { start, .. } => Some(start),
        Span::Handler(at) => Some(at),
        _ => None,
    };
    if at
        .and_then(|at| owner(bodies, at))
        .is_some_and(|index| bodies[index].prepared)
    {
        return;
    }
    match *span {
        Span::Await {
            start,
            operand,
            end,
        } => {
            let s = owner(bodies, start).is_some_and(|index| bodies[index].suspension_handlers);
            await_edits(edits, source, start, operand, end, s);
        }
        Span::Yield {
            start,
            operand,
            end,
            asynchronous: true,
        } if owner(bodies, start).is_some_and(|index| bodies[index].suspension_handlers)
            && !already_hooked(source, start) =>
        {
            edits.open(start, end, 3);
            edits.open(operand, end, 3);
            edits.close(end, start, 7);
        }
        Span::Handler(at)
            if owner(bodies, at).is_some_and(|index| bodies[index].suspension_handlers)
                && !source[at..].trim_start().starts_with("__bunwasm_caught(") =>
        {
            edits.at(at, 6)
        }
        Span::Loop {
            start,
            iterable,
            iterable_end,
            body,
            end,
            block,
        } => {
            loop_edits(
                edits,
                source,
                spans,
                start,
                iterable,
                iterable_end,
                body,
                end,
                block,
            );
        }
        Span::Eval { start, indirect } => eval_edits(edits, source, spans, start, indirect),
        _ => (),
    }
}

#[allow(clippy::too_many_arguments)]
fn loop_edits(
    edits: &mut Edits,
    source: &str,
    spans: &[Span],
    mut start: usize,
    iterable: usize,
    iterable_end: usize,
    body: usize,
    end: usize,
    block: bool,
) {
    if source[iterable..iterable_end]
        .trim_start()
        .starts_with("__bunwasm_c = __bunwasm_iterate(")
    {
        return;
    }
    while let Some(outer) = spans.iter().find_map(|span| match span {
        Span::Label { start: outer, body } if *body == start && *outer < start => Some(*outer),
        _ => None,
    }) {
        start = outer;
    }
    edits.open(start, end, 8);
    edits.open(iterable, iterable_end, 9);
    edits.close(iterable_end, iterable, 1);
    edits.at(
        if block { body + 1 } else { body },
        if block { 10 } else { 13 },
    );
    edits.close(
        if block { end - 1 } else { end },
        body,
        if block { 11 } else { 14 },
    );
    edits.close(end, start, 12);
}

fn eval_edits(edits: &mut Edits, source: &str, spans: &[Span], call: usize, indirect: bool) {
    let argument = spans.iter().find_map(|span| match span {
        Span::Argument {
            call: parent,
            start,
            end,
            spread,
        } if *parent == call => Some((*start, *end, *spread)),
        _ => None,
    });
    let Some((start, end, spread)) = argument else {
        return;
    };
    let argument_source = source[start..end].trim_start();
    if argument_source.starts_with("__bunwasm_evalArg(")
        || argument_source.starts_with("__bunwasm_evalSpread(")
    {
        return;
    }
    edits.open(start, end, if spread { 18 } else { 15 });
    edits.close(end, start, if indirect { 17 } else { 1 });
}

fn options() -> bun_js_parser::ParserOptions<'static> {
    let mut options = bun_js_parser::ParserOptions::init(Default::default(), bun_ast::Loader::Js);
    options.features.top_level_await = false;
    options.features.no_macros = true;
    options.suppress_warnings_about_weird_code = true;
    options
}

fn parse(source: &str) -> Result<(Vec<Span>, Vec<usize>), String> {
    let arena = bun_alloc::Arena::new();
    let mut memory = bun_ast::ASTMemoryAllocator::borrowing(&arena);
    let _scope = memory.enter();
    let input = bun_ast::Source::init_path_string(b"<prepare.js>", source.as_bytes());
    let mut log = bun_ast::Log::init();
    let define = Default::default();
    let parser = bun_js_parser::Parser::init(options(), &mut log, &input, &define, &arena)
        .map_err(|error| format!("{error:?}"))?;
    let ((result, imports), spans) = bun_js_parser::with_bunwasm_splices(|| {
        bun_js_parser::with_bunwasm_dynamic_imports(|| parser.parse_only(|_| ()))
    });
    result.map_err(|error| format!("{error:?}"))?;
    Ok((spans, imports))
}

/// What the parse pass knows about a context script's top level.
struct Script {
    /// The final top-level expression statement, which `return`s the completion value.
    completion: Option<usize>,
    /// A parameter name no scope in the source declares.
    scope: String,
}

fn script(parsed: &bun_js_parser::parse::parse_entry::ParsedOnly) -> Result<Script, &'static str> {
    use bun_ast::stmt::Data as S;
    for stmt in parsed.stmts {
        let exported = match stmt.data {
            S::SImport(_) => return Err("Cannot use import statement outside a module"),
            S::SReturn(_) => return Err("Illegal return statement"),
            S::SLocal(local) => local.is_export,
            S::SClass(class) => class.is_export,
            S::SFunction(function) => function
                .func
                .flags
                .contains(bun_ast::flags::Function::IsExport),
            data => data.tag().is_export_like() && !matches!(data, S::SEmpty(_)),
        };
        if exported {
            return Err("Unexpected token 'export'");
        }
    }
    let completion = parsed
        .stmts
        .iter()
        .rev()
        .find(|stmt| !matches!(stmt.data, S::SEmpty(_) | S::SFunction(_)))
        .filter(|stmt| matches!(stmt.data, S::SExpr(_)))
        .map(|stmt| stmt.loc.start as usize);
    let scope = (0..)
        .map(|suffix| match suffix {
            0 => "__bunwasm_vm".to_owned(),
            _ => format!("__bunwasm_vm{suffix}"),
        })
        .find(|name| {
            !parsed.declares(name.as_bytes())
                && !parsed.declares(format!("{name}_typeof").as_bytes())
        })
        .expect("a finite source declares finitely many names");
    Ok(Script { completion, scope })
}

fn first_error(log: &bun_ast::Log, spans: &[Span]) -> Option<String> {
    let runtime = spans
        .iter()
        .filter_map(|span| match span {
            Span::RuntimeDiagnostic(index) => Some(*index),
            _ => None,
        })
        .collect::<std::collections::BTreeSet<_>>();
    log.msgs
        .iter()
        .enumerate()
        .find(|(index, msg)| matches!(msg.kind, bun_ast::Kind::Err) && !runtime.contains(index))
        .map(|(_, msg)| String::from_utf8_lossy(&msg.data.text).into_owned())
}

/// Parses `source` as a script twice: once for its statements, once through the visit pass, whose
/// binder records the references no declaration in the source binds.
fn parse_context(source: &str) -> Result<(Script, Vec<Span>), String> {
    let arena = bun_alloc::Arena::new();
    let mut memory = bun_ast::ASTMemoryAllocator::borrowing(&arena);
    let _scope = memory.enter();
    let input = bun_ast::Source::init_path_string(b"<prepare.js>", source.as_bytes());
    let define = Default::default();
    let mut log = bun_ast::Log::init();
    let parsed = bun_js_parser::Parser::init(options(), &mut log, &input, &define, &arena)
        .and_then(|parser| parser.parse_only(script));
    if let Some(error) = first_error(&log, &[]) {
        return Err(error);
    }
    let script = match parsed {
        Ok(script) => script?,
        Err(error) => return Err(format!("{error:?}")),
    };
    let mut log = bun_ast::Log::init();
    let parser = bun_js_parser::Parser::init(options(), &mut log, &input, &define, &arena)
        .map_err(|error| format!("{error:?}"))?;
    // Only the recorded runtime-only diagnostics may survive the visit; early errors must reject.
    let (visited, spans) = bun_js_parser::with_bunwasm_splices(|| parser.parse());
    if let Some(error) = first_error(&log, &spans) {
        return Err(error);
    }
    if spans.iter().any(|span| matches!(span, Span::StrictDelete)) {
        return Err("Cannot delete an unqualified identifier in strict mode".to_owned());
    }
    if let Err(error) = visited
        && !spans
            .iter()
            .any(|span| matches!(span, Span::RuntimeDiagnostic(_)))
    {
        return Err(format!("{error:?}"));
    }
    Ok((script, spans))
}

fn context_edits(spans: &[Span]) -> Edits {
    let at = |wanted: fn(&Span) -> Option<usize>| {
        spans
            .iter()
            .filter_map(wanted)
            .collect::<std::collections::BTreeSet<_>>()
    };
    let callees = at(|span| match span {
        Span::Callee(at) => Some(*at),
        _ => None,
    });
    let typeofs = at(|span| match span {
        Span::Typeof(at) => Some(*at),
        _ => None,
    });
    let shorthands = at(|span| match span {
        Span::Shorthand(at) => Some(*at),
        _ => None,
    });
    let mut edits = Edits::default();
    for span in spans {
        let Span::Free { start, end } = *span else {
            continue;
        };
        let kind = if shorthands.contains(&start) {
            SCOPE_SHORTHAND
        } else if typeofs.contains(&start) {
            SCOPE_TYPEOF
        } else if callees.contains(&start) {
            SCOPE_CALL
        } else {
            SCOPE_READ
        };
        let deleted = if kind == SCOPE_SHORTHAND {
            end - start
        } else {
            0
        };
        edits.0.push((start, deleted, kind, 1));
        if kind == SCOPE_CALL {
            edits.0.push((end, 0, 1, 1));
        }
    }
    edits
}

/// Goal "vm-context": every reference that no declaration in `source` binds becomes a member of
/// the scope parameter, and the final top-level expression statement returns its value.
fn prepare_context(source: &str) -> Value {
    let range = 0..source.len();
    let (script, spans) = match parse_context(source) {
        Ok(parsed) => parsed,
        Err(error) => return result(source, Edits::default(), range, Some(error), &[], ""),
    };
    let mut edits = context_edits(&spans);
    if let Some(at) = script.completion {
        edits.0.push((at, 0, COMPLETION, 0));
    }
    let mut value = result(source, edits, range, None, &[], &script.scope);
    value["scope"] = json!(script.scope);
    value
}

fn already_prepared(source: &str, spans: &[Span]) -> bool {
    spans.iter().any(|span| match *span {
        Span::Await { start, .. } | Span::Yield { start, .. } => already_hooked(source, start),
        Span::Loop {
            iterable,
            iterable_end,
            ..
        } => source[iterable..iterable_end]
            .trim_start()
            .starts_with("__bunwasm_c = __bunwasm_iterate("),
        Span::Prologue { end, .. } => source[end..]
            .trim_start()
            .starts_with("let __bunwasm_s = 0;"),
        Span::Argument { start, end, .. } => {
            let argument = source[start..end].trim_start();
            argument.starts_with("__bunwasm_evalArg(")
                || argument.starts_with("__bunwasm_evalSpread(")
        }
        _ => false,
    })
}

fn result(
    source: &str,
    mut edits: Edits,
    range: std::ops::Range<usize>,
    fallback: Option<String>,
    spans: &[Span],
    scope: &str,
) -> Value {
    edits.0.sort_by_key(|edit| (edit.0, edit.3));
    edits.0.dedup();
    let mut triples = Vec::new();
    let mut columns = Vec::new();
    let mut inserted_by_line = BTreeMap::<usize, usize>::new();
    for (at, delete, kind, _) in edits
        .0
        .into_iter()
        .filter(|edit| range.start <= edit.0 && edit.0 <= range.end)
    {
        let prefix = &source[range.start..at];
        let offset = prefix.encode_utf16().count();
        let delete = source[at..at + delete].encode_utf16().count();
        triples.extend([offset as i32, delete as i32, kind as i32]);
        let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
        let column = prefix
            .rsplit('\n')
            .next()
            .unwrap_or("")
            .encode_utf16()
            .count()
            + 1;
        let inserted = inserted_by_line.entry(line).or_default();
        let length = inserted_len(kind, delete, scope);
        columns.extend([line as i32, (column + *inserted) as i32, length as i32]);
        *inserted += length;
    }
    json!({ "version": PREPARE_VERSION, "alreadyPrepared": already_prepared(source, spans), "edits": triples, "columns": columns, "fallback": fallback,
        "spreadEval": spans.iter().filter(|span| matches!(span, Span::Argument { call, spread: true, .. } if spans.iter().any(|site| matches!(site, Span::Eval { start, .. } if start == call)))).count(),
        "unhookedAwaitUsing": spans.iter().filter(|span| matches!(span, Span::AwaitUsing)).count() })
}

pub fn prepare(source: &str, goal: &str) -> Value {
    if goal == "vm-context" {
        return prepare_context(source);
    }
    let (text, start) = if goal == "eval" {
        (
            format!("({{__bunwasm_e(){{\n{source}\n}}}})"),
            "({__bunwasm_e(){\n".len(),
        )
    } else {
        (source.to_owned(), 0)
    };
    let range = start..start + source.len();
    match parse(&text) {
        Ok((spans, imports)) => result(
            &text,
            collect(&text, &spans, &imports),
            range,
            None,
            &spans,
            "",
        ),
        Err(error) => result(&text, Edits::default(), range, Some(error), &[], ""),
    }
}

pub fn function(args: &[String], kind: &str, hooks: bool) -> Vec<Value> {
    if args.is_empty() {
        return Vec::new();
    }
    let prefix = match kind {
        "async" => "async function",
        "generator" => "function*",
        "async-generator" => "async function*",
        _ => "function",
    };
    let mut text = format!("({prefix} anonymous(");
    let mut ranges = Vec::new();
    for (index, arg) in args.iter().enumerate() {
        if index == args.len() - 1 {
            text.push_str("\n){\n");
        } else if index > 0 {
            text.push(',');
        }
        let start = text.len();
        text.push_str(arg);
        ranges.push(start..text.len());
    }
    text.push_str("\n})");
    let (spans, imports) = match parse(&text) {
        Ok(parsed) => parsed,
        Err(error) => {
            return ranges
                .into_iter()
                .map(|range| result(&text, Edits::default(), range, Some(error.clone()), &[], ""))
                .collect();
        }
    };
    let edits = if hooks {
        collect(&text, &spans, &imports)
    } else {
        Edits(imports.iter().map(|at| (*at, 6, 16, 0)).collect())
    };
    ranges
        .into_iter()
        .map(|range| result(&text, edits.clone(), range, None, &spans, ""))
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn prepares_first_spread_eval_argument_once() {
        let direct = super::prepare("eval(...xs)", "script");
        assert_eq!(direct["version"], json!(super::PREPARE_VERSION));
        assert_eq!(direct["edits"], json!([8, 0, 18, 10, 0, 1]));

        let indirect = super::prepare("(0, eval)(...xs)", "script");
        assert_eq!(indirect["edits"], json!([13, 0, 18, 15, 0, 17]));

        let prepared = super::prepare("eval(...__bunwasm_evalSpread(eval, xs))", "script");
        assert_eq!(prepared["edits"], json!([]));
    }

    #[test]
    fn measures_computed_shorthand_columns() {
        let prepared = super::prepare("({__proto__})", "vm-context");
        assert_eq!(prepared["columns"], json!([1, 1, 7, 1, 10, 28]));
    }

    #[test]
    fn prepares_vm_context_scripts_from_the_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/vm-context-prepare.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let source = case["source"].as_str().unwrap();
            let prepared = super::prepare(source, "vm-context");
            let actual = json!({ "edits": prepared["edits"], "scope": prepared["scope"], "fallback": prepared["fallback"] });
            let expected = json!({ "edits": case["edits"], "scope": case["scope"], "fallback": case["fallback"] });
            assert_eq!(actual, expected, "{}", case["name"]);
        }
    }
}
