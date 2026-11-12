//! Source-map-preserving corrections to a printed registration record body (see
//! `register.rs`).
//!
//! A module's `arguments`: in a module, `arguments` is an ordinary global-scope reference. A
//! record body runs inside a generator, whose own `arguments` would shadow it, so
//! `register::prepare` renames the module's unbound `arguments` symbol, whatever escapes
//! its source spells it with, to a placeholder. The placeholder is allocated to differ from
//! every name and every piece of text in the module, so each printed occurrence is that
//! symbol, and it is rewritten to read through the loader: `<api>.ga()` evaluates
//! `arguments` in the global scope (a read or a call target, called without a receiver as
//! natively), `<api>.gt()` its `typeof`. Assigning to `arguments` is a parse error in a
//! module.
//!
//! Calls of imported functions: a record prints `f(x)` as `(0, <view>.f)(x)`, `<view>` being
//! the header binding of the dependency's binding view. V8 places such a call at its
//! argument list, but a plain call at its callee, so the record maps the argument list's
//! `(` to where the call starts, and a stack frame keeps the column the module would report
//! natively.
//!
//! Mapping columns are UTF-16 code units, as the printer writes them.

/// The record's generated names the corrections look for (see `register::RecordNames`).
pub(crate) struct Names<'a> {
    pub api: &'a str,
    pub arguments: &'a str,
    /// The header bindings of named imports' binding views.
    pub views: Vec<&'a str>,
}

/// One decoded segment with absolute values: generated column, then source index, line,
/// column and name index when present.
struct Segment {
    gen_col: i64,
    rest: Vec<i64>,
}

struct Edit {
    line: usize,
    start: usize,
    old_len: usize,
    text: String,
}

/// The fixed body and mappings, or `None` when nothing needed a change.
pub(crate) struct Fixed {
    pub code: String,
    pub mappings: String,
}

pub(crate) fn fix(code: &str, mappings: &str, names: &Names<'_>) -> Option<Fixed> {
    let calls_possible = names.views.iter().any(|view| code.contains(view));
    if mappings.is_empty() || !(code.contains(names.arguments) || calls_possible) {
        return None;
    }
    let mut lines = decode(mappings);
    let arguments = fix_arguments(code, &mut lines, names);
    let changed = arguments.is_some();
    let code = arguments.unwrap_or_else(|| code.to_owned());
    let calls = map_namespace_calls(&code, &mut lines, &names.views);
    (changed || calls > 0).then(|| Fixed {
        code,
        mappings: encode(&lines),
    })
}

fn fix_arguments(code: &str, lines: &mut [Vec<Segment>], names: &Names<'_>) -> Option<String> {
    if !code.contains(names.arguments) {
        return None;
    }
    let code_lines: Vec<&str> = code.split('\n').collect();
    let mut edits = Vec::new();
    for (line, text) in code_lines.iter().enumerate() {
        edits.extend(
            words(text, names.arguments).map(|start| argument_edit(line, text, start, names)),
        );
    }
    if edits.is_empty() {
        return None;
    }
    shift(lines, &code_lines, &edits);
    Some(apply(&code_lines, &edits))
}

/// Byte offsets of `name` as a whole identifier in `text`.
fn words<'a>(text: &'a str, name: &'a str) -> impl Iterator<Item = usize> + 'a {
    let identifier = |c: char| c == '$' || c == '_' || c.is_alphanumeric();
    text.match_indices(name)
        .map(|(start, _)| start)
        .filter(move |&start| {
            let before = text[..start].chars().next_back().is_some_and(identifier);
            let after = text[start + name.len()..]
                .chars()
                .next()
                .is_some_and(identifier);
            !before && !after
        })
}

fn argument_edit(line: usize, text: &str, start: usize, names: &Names<'_>) -> Edit {
    const TYPEOF: &str = "typeof ";
    if text[..start].ends_with(TYPEOF) {
        return Edit {
            line,
            start: start - TYPEOF.len(),
            old_len: TYPEOF.len() + names.arguments.len(),
            text: format!("{}.gt()", names.api),
        };
    }
    Edit {
        line,
        start,
        old_len: names.arguments.len(),
        text: format!("{}.ga()", names.api),
    }
}

/// Adds a segment at the argument list of each `(0, <view>.f)(` that copies the segment
/// where the call starts. Returns how many were added.
fn map_namespace_calls(code: &str, lines: &mut [Vec<Segment>], views: &[&str]) -> usize {
    let mut added = 0;
    for (text, segments) in code.split('\n').zip(lines.iter_mut()) {
        for view in views {
            let prefix = format!("(0, {view}");
            let calls = text
                .match_indices(prefix.as_str())
                .filter_map(|(start, _)| {
                    Some((start, namespace_callee_end(&text[start..], &prefix)?))
                });
            for (start, arguments) in calls.collect::<Vec<_>>() {
                let call = text[..start].encode_utf16().count() as i64;
                let list = call + text[start..start + arguments].encode_utf16().count() as i64;
                added += usize::from(copy_segment(segments, call, list));
            }
        }
    }
    added
}

/// For text starting `(0, <view>.name)(` (or `[“string”]` for the name), `prefix` being
/// `(0, <view>`, the byte offset of the argument list's `(`.
fn namespace_callee_end(text: &str, prefix: &str) -> Option<usize> {
    let rest = text.strip_prefix(prefix)?;
    let member = member_length(rest)?;
    rest[member..]
        .starts_with(")(")
        .then(|| text.len() - rest.len() + member + 1)
}

/// The length of `.name` or `["string"]` at the start of `text`.
fn member_length(text: &str) -> Option<usize> {
    if let Some(name) = text.strip_prefix('.') {
        let end = name
            .find(|c: char| !(c == '$' || c == '_' || c.is_alphanumeric()))
            .unwrap_or(name.len());
        return (end > 0).then_some(end + 1);
    }
    let string = text.strip_prefix("[\"")?;
    let mut escaped = false;
    for (offset, c) in string.char_indices() {
        if escaped || c == '\\' {
            escaped = !escaped && c == '\\';
            continue;
        }
        if c == '"' {
            return string[offset + 1..]
                .starts_with(']')
                .then_some(2 + offset + 2);
        }
    }
    None
}

/// Copies the first segment in the callee `from..to` (the printer marks the imported name,
/// after `(0, `) to column `to`, unless `to` already has one.
fn copy_segment(segments: &mut Vec<Segment>, from: i64, to: i64) -> bool {
    if segments.iter().any(|segment| segment.gen_col == to) {
        return false;
    }
    let Some(source) = segments
        .iter()
        .find(|segment| (from..to).contains(&segment.gen_col))
    else {
        return false;
    };
    let copy = Segment {
        gen_col: to,
        rest: source.rest.clone(),
    };
    let index = segments.partition_point(|segment| segment.gen_col < to);
    segments.insert(index, copy);
    true
}

fn apply(code_lines: &[&str], edits: &[Edit]) -> String {
    let mut out = String::new();
    for (index, text) in code_lines.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let mut at = 0;
        for edit in edits.iter().filter(|edit| edit.line == index) {
            out.push_str(&text[at..edit.start]);
            out.push_str(&edit.text);
            at = edit.start + edit.old_len;
        }
        out.push_str(&text[at..]);
    }
    out
}

/// Moves the generated columns of segments after each edit on its line. A segment inside a
/// replaced span (the identifier of `typeof arguments`) moves to the span's start. Replaced
/// spans and replacements are generated names and ASCII punctuation, whose UTF-16 lengths
/// are counted from their text.
fn shift(lines: &mut [Vec<Segment>], code_lines: &[&str], edits: &[Edit]) {
    for edit in edits.iter().rev() {
        let Some(text) = code_lines.get(edit.line) else {
            continue;
        };
        let units = |s: &str| s.encode_utf16().count() as i64;
        let start = units(&text[..edit.start]);
        let old = units(&text[edit.start..edit.start + edit.old_len]);
        let end = start + old;
        let delta = units(&edit.text) - old;
        for segment in &mut lines[edit.line] {
            segment.gen_col = shifted(segment.gen_col, start, end, delta);
        }
    }
}

fn shifted(column: i64, start: i64, end: i64, delta: i64) -> i64 {
    if column >= end {
        return column + delta;
    }
    if column > start { start } else { column }
}

fn decode(mappings: &str) -> Vec<Vec<Segment>> {
    let mut previous = [0i64; 4];
    mappings
        .split(';')
        .map(|line| decode_line(line, &mut previous))
        .collect()
}

/// Generated columns restart on every line; the other fields continue across lines.
fn decode_line(line: &str, previous: &mut [i64; 4]) -> Vec<Segment> {
    let mut gen_col = 0i64;
    let mut segments = Vec::new();
    for text in line.split(',').filter(|s| !s.is_empty()) {
        let fields = vlq_decode(text);
        gen_col += fields[0];
        let rest = fields[1..]
            .iter()
            .zip(previous.iter_mut())
            .map(|(value, last)| {
                *last += value;
                *last
            });
        segments.push(Segment {
            gen_col,
            rest: rest.collect(),
        });
    }
    segments
}

fn encode(lines: &[Vec<Segment>]) -> String {
    let mut previous = [0i64; 4];
    let mut out = String::new();
    for (index, segments) in lines.iter().enumerate() {
        if index > 0 {
            out.push(';');
        }
        encode_line(segments, &mut previous, &mut out);
    }
    out
}

fn encode_line(segments: &[Segment], previous: &mut [i64; 4], out: &mut String) {
    let mut gen_col = 0i64;
    for (position, segment) in segments.iter().enumerate() {
        if position > 0 {
            out.push(',');
        }
        vlq_encode(segment.gen_col - gen_col, out);
        gen_col = segment.gen_col;
        let fields = segment.rest.iter().zip(previous.iter_mut());
        fields.for_each(|(value, last)| {
            vlq_encode(value - *last, out);
            *last = *value;
        });
    }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn vlq_decode(text: &str) -> Vec<i64> {
    let mut values = Vec::with_capacity(5);
    let (mut value, mut shift) = (0i64, 0);
    for byte in text.bytes() {
        let Some(digit) = BASE64.iter().position(|&b| b == byte) else {
            break;
        };
        let digit = digit as i64;
        value |= (digit & 31) << shift;
        if digit & 32 != 0 {
            shift += 5;
            continue;
        }
        values.push(if value & 1 == 1 {
            -(value >> 1)
        } else {
            value >> 1
        });
        (value, shift) = (0, 0);
    }
    values
}

fn vlq_encode(value: i64, out: &mut String) {
    let mut rest = if value < 0 {
        ((-value) << 1) | 1
    } else {
        value << 1
    };
    loop {
        let mut digit = rest & 31;
        rest >>= 5;
        if rest > 0 {
            digit |= 32;
        }
        out.push(BASE64[digit as usize] as char);
        if rest == 0 {
            return;
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The relative fields of one mapping segment.
    pub(crate) fn decode_fields(segment: &str) -> Vec<i64> {
        vlq_decode(segment)
    }

    #[test]
    fn vlq_round_trips() {
        for value in [0, 1, -1, 15, 16, -16, 1000, -123456] {
            let mut out = String::new();
            vlq_encode(value, &mut out);
            assert_eq!(vlq_decode(&out), vec![value]);
        }
        let mappings = "AAAA,IAAU;EAEJ;;CACC";
        assert_eq!(encode(&decode(mappings)), mappings);
    }

    fn names<'a>(views: Vec<&'a str>) -> Names<'a> {
        Names {
            api: "__bunwasm_m",
            arguments: "__bunwasm_arguments",
            views,
        }
    }

    #[test]
    fn namespace_callees() {
        let view = "(0, __bunwasm_ns0_1";
        assert_eq!(
            namespace_callee_end("(0, __bunwasm_ns0_1.test)(1)", view),
            Some(25)
        );
        assert_eq!(
            namespace_callee_end(
                r#"(0, __bunwasm_ns12_3["a-\"b"])()"#,
                "(0, __bunwasm_ns12_3"
            ),
            Some(30)
        );
        assert_eq!(
            namespace_callee_end("(0, __bunwasm_ns0_1.test)", view),
            None
        );
        assert_eq!(namespace_callee_end("(0, __bunwasm_ns0_1)()", view), None);
        // As printed: the call's segment marks the imported name (column 4), then a later
        // token (30); the argument list (25) gets the call's original position.
        let fixed = fix(
            "(0, __bunwasm_ns0_0.test)(\"no body\");",
            "IACE,0BAAK",
            &names(vec!["__bunwasm_ns0_0"]),
        )
        .expect("a call segment");
        assert_eq!(fixed.mappings, "IACE,qBAAA,KAAK");
        // A view name that only prefixes the printed one is a different binding.
        assert!(
            fix(
                "(0, __bunwasm_ns0_01.test)(1);",
                "IACE",
                &names(vec!["__bunwasm_ns0_0"])
            )
            .is_none()
        );
    }

    fn line(columns: &[i64]) -> String {
        let segments = columns
            .iter()
            .enumerate()
            .map(|(index, &gen_col)| Segment {
                gen_col,
                rest: vec![0, 0, index as i64],
            })
            .collect::<Vec<_>>();
        encode(&[segments])
    }

    #[test]
    fn arguments_are_whole_placeholder_words_shifted_in_utf16() {
        // `é` and `😀` are one and two UTF-16 units, so the placeholder starts at column 4
        // and its `;` is at 23; `typeof ` starts at 24 and its operand at 31; the identifier
        // that only contains the placeholder starts at 51.
        let code = "é😀;__bunwasm_arguments;typeof __bunwasm_arguments;x__bunwasm_arguments;";
        let fixed = fix(code, &line(&[4, 23, 31, 51]), &names(Vec::new())).expect("edits");
        assert_eq!(
            fixed.code,
            "é😀;__bunwasm_m.ga();__bunwasm_m.gt();x__bunwasm_arguments;"
        );
        // ga() is 16 units for the 19-unit placeholder (-3); gt() is 16 for the 26 units of
        // `typeof ` and the placeholder (-10), and the operand's segment moves to its start.
        let columns: Vec<i64> = decode(&fixed.mappings)[0]
            .iter()
            .map(|s| s.gen_col)
            .collect();
        assert_eq!(columns, vec![4, 20, 21, 38]);
        let originals: Vec<i64> = decode(&fixed.mappings)[0]
            .iter()
            .map(|s| s.rest[2])
            .collect();
        assert_eq!(originals, vec![0, 1, 2, 3]);
    }
}
