//! Insertion-only preparation of runtime-built JavaScript.
use bun_js_parser::BunwasmSplice as Span;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const PREPARE_VERSION: u32 = 4;

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
];

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
            spread: false,
        } if *parent == call => Some((*start, *end)),
        _ => None,
    });
    let Some((start, end)) = argument else {
        return;
    };
    if source[start..end]
        .trim_start()
        .starts_with("__bunwasm_evalArg(")
    {
        return;
    }
    edits.open(start, end, 15);
    edits.close(end, start, if indirect { 17 } else { 1 });
}

fn parse(source: &str) -> Result<(Vec<Span>, Vec<usize>), String> {
    let arena = bun_alloc::Arena::new();
    let mut memory = bun_ast::ASTMemoryAllocator::borrowing(&arena);
    let _scope = memory.enter();
    let input = bun_ast::Source::init_path_string(b"<prepare.js>", source.as_bytes());
    let mut options = bun_js_parser::ParserOptions::init(Default::default(), bun_ast::Loader::Js);
    options.features.top_level_await = false;
    options.features.no_macros = true;
    options.suppress_warnings_about_weird_code = true;
    let mut log = bun_ast::Log::init();
    let define = Default::default();
    let parser = bun_js_parser::Parser::init(options, &mut log, &input, &define, &arena)
        .map_err(|error| format!("{error:?}"))?;
    let ((result, imports), spans) = bun_js_parser::with_bunwasm_splices(|| {
        bun_js_parser::with_bunwasm_dynamic_imports(|| parser.parse_only(|_| ()))
    });
    result.map_err(|error| format!("{error:?}"))?;
    Ok((spans, imports))
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
        Span::Argument { start, end, .. } => source[start..end]
            .trim_start()
            .starts_with("__bunwasm_evalArg("),
        _ => false,
    })
}

fn result(
    source: &str,
    mut edits: Edits,
    range: std::ops::Range<usize>,
    fallback: Option<String>,
    spans: &[Span],
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
        let length = TEXT[kind].len() - delete;
        columns.extend([line as i32, (column + *inserted) as i32, length as i32]);
        *inserted += length;
    }
    json!({ "version": PREPARE_VERSION, "alreadyPrepared": already_prepared(source, spans), "edits": triples, "columns": columns, "fallback": fallback,
        "spreadEval": spans.iter().filter(|span| matches!(span, Span::Argument { call, spread: true, .. } if spans.iter().any(|site| matches!(site, Span::Eval { start, .. } if start == call)))).count(),
        "unhookedAwaitUsing": spans.iter().filter(|span| matches!(span, Span::AwaitUsing)).count() })
}

pub fn prepare(source: &str, goal: &str) -> Value {
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
        Ok((spans, imports)) => {
            result(&text, collect(&text, &spans, &imports), range, None, &spans)
        }
        Err(error) => result(&text, Edits::default(), range, Some(error), &[]),
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
                .map(|range| result(&text, Edits::default(), range, Some(error.clone()), &[]))
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
        .map(|range| result(&text, edits.clone(), range, None, &spans))
        .collect()
}
