//! Source-map-guided corrections to a printed registration record body (see `register.rs`).
//!
//! A module's `arguments`: in a module, `arguments` is an ordinary global-scope reference. A
//! record body runs inside a generator, whose own `arguments` would shadow it, so
//! `register::prepare` renames the module's unbound `arguments` to [`ARGUMENTS`]. Its uses
//! are found through the printer's source map, which marks every identifier it prints, and
//! are rewritten to read through the loader: `__bunwasm_m.ga()` evaluates `arguments` in the
//! global scope (a read or a call target, called without a receiver as natively),
//! `__bunwasm_m.gt()` its `typeof`. Assigning to `arguments` is a parse error in a module.
//!
//! Calls of imported functions: a record prints `f(x)` as `(0, __bunwasm_nsR_K.f)(x)`. V8
//! places such a call at its argument list, but a plain call at its callee, so the record
//! maps the argument list's `(` to where the call starts, and a stack frame keeps the
//! column the module would report natively.
//!
//! Mapping columns are UTF-16 code units, as the printer writes them.

/// The printed name of a module's unbound `arguments` (see `register::prepare`).
pub(crate) const ARGUMENTS: &str = "__bunwasm_arguments";

const GLOBAL_ARGUMENTS: &str = "__bunwasm_m.ga()";
const GLOBAL_ARGUMENTS_TYPEOF: &str = "__bunwasm_m.gt()";

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
    text: &'static str,
}

/// The fixed body and mappings, or `None` when nothing needed a change.
pub(crate) struct Fixed {
    pub code: String,
    pub mappings: String,
}

/// `input` is the source the record was parsed from.
pub(crate) fn fix(code: &str, mappings: &str, input: &str) -> Option<Fixed> {
    if mappings.is_empty() || !(code.contains(ARGUMENTS) || code.contains(NAMESPACE_CALL)) {
        return None;
    }
    let mut lines = decode(mappings);
    let arguments = fix_arguments(code, &mut lines, input);
    let changed = arguments.is_some();
    let code = arguments.unwrap_or_else(|| code.to_owned());
    let calls = map_namespace_calls(&code, &mut lines);
    (changed || calls > 0).then(|| Fixed {
        code,
        mappings: encode(&lines),
    })
}

fn fix_arguments(code: &str, lines: &mut [Vec<Segment>], input: &str) -> Option<String> {
    if !code.contains(ARGUMENTS) {
        return None;
    }
    let input_lines: Vec<&str> = input.split('\n').collect();
    let code_lines: Vec<&str> = code.split('\n').collect();
    let mut edits = Vec::new();
    for (line, (segments, text)) in lines.iter().zip(&code_lines).enumerate() {
        edits.extend(
            segments
                .iter()
                .filter_map(|segment| edit_at(line, text, segment, &input_lines)),
        );
    }
    if edits.is_empty() {
        return None;
    }
    edits.sort_by_key(|edit| (edit.line, edit.start));
    edits.dedup_by_key(|edit| (edit.line, edit.start));
    shift(lines, &code_lines, &edits);
    Some(apply(&code_lines, &edits))
}

const NAMESPACE_CALL: &str = "(0, __bunwasm_ns";

/// Adds a segment at the argument list of each `(0, __bunwasm_nsR_K.f)(` that copies the
/// segment where the call starts. Returns how many were added.
fn map_namespace_calls(code: &str, lines: &mut [Vec<Segment>]) -> usize {
    let mut added = 0;
    for (text, segments) in code.split('\n').zip(lines.iter_mut()) {
        let calls = text
            .match_indices(NAMESPACE_CALL)
            .filter_map(|(start, _)| Some((start, namespace_callee_end(&text[start..])?)));
        for (start, arguments) in calls {
            let call = text[..start].encode_utf16().count() as i64;
            let list = call + text[start..start + arguments].encode_utf16().count() as i64;
            added += usize::from(copy_segment(segments, call, list));
        }
    }
    added
}

/// For text starting `(0, __bunwasm_nsR_K.name)(` (or `[“string”]` for the name), the byte
/// offset of the argument list's `(`.
fn namespace_callee_end(text: &str) -> Option<usize> {
    let rest = text.strip_prefix(NAMESPACE_CALL)?;
    let digits = |s: &str| s.find(|c: char| !c.is_ascii_digit()).filter(|&n| n > 0);
    let after_request = digits(rest)?;
    let rest = rest[after_request..].strip_prefix('_')?;
    let after_index = digits(rest)?;
    let rest = &rest[after_index..];
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

fn edit_at(line: usize, text: &str, segment: &Segment, input_lines: &[&str]) -> Option<Edit> {
    let &[_, orig_line, orig_col, ..] = &segment.rest[..] else {
        return None;
    };
    let start = byte_offset(text, segment.gen_col)?;
    let source = input_lines.get(usize::try_from(orig_line).ok()?)?;
    let origin = &source[byte_offset(source, orig_col)?..];
    if !word(&text[start..], ARGUMENTS) || !word(origin, "arguments") {
        return None;
    }
    const TYPEOF: &str = "typeof ";
    if text[..start].ends_with(TYPEOF) {
        let start = start - TYPEOF.len();
        return Some(Edit {
            line,
            start,
            old_len: TYPEOF.len() + ARGUMENTS.len(),
            text: GLOBAL_ARGUMENTS_TYPEOF,
        });
    }
    Some(Edit {
        line,
        start,
        old_len: ARGUMENTS.len(),
        text: GLOBAL_ARGUMENTS,
    })
}

/// `text` starts with the whole identifier `token`.
fn word(text: &str, token: &str) -> bool {
    let Some(after) = text.strip_prefix(token) else {
        return false;
    };
    !after
        .chars()
        .next()
        .is_some_and(|c| c == '$' || c == '_' || c.is_alphanumeric())
}

/// Byte offset of a UTF-16 column within one line.
fn byte_offset(line: &str, column: i64) -> Option<usize> {
    let mut units = 0i64;
    for (offset, c) in line.char_indices() {
        if units == column {
            return Some(offset);
        }
        units += c.len_utf16() as i64;
    }
    (units == column).then_some(line.len())
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
            out.push_str(edit.text);
            at = edit.start + edit.old_len;
        }
        out.push_str(&text[at..]);
    }
    out
}

/// Moves the generated columns of segments after each edit on its line. A segment inside a
/// replaced span (the identifier of `typeof arguments`) moves to the span's start. Replaced
/// spans and replacements are ASCII, so their byte and UTF-16 lengths agree.
fn shift(lines: &mut [Vec<Segment>], code_lines: &[&str], edits: &[Edit]) {
    for edit in edits.iter().rev() {
        let Some(text) = code_lines.get(edit.line) else {
            continue;
        };
        let start = text[..edit.start].encode_utf16().count() as i64;
        let end = start + edit.old_len as i64;
        let delta = edit.text.len() as i64 - edit.old_len as i64;
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

    #[test]
    fn namespace_callees() {
        assert_eq!(
            namespace_callee_end("(0, __bunwasm_ns0_1.test)(1)"),
            Some(25)
        );
        assert_eq!(
            namespace_callee_end(r#"(0, __bunwasm_ns12_3["a-\"b"])()"#),
            Some(30)
        );
        assert_eq!(namespace_callee_end("(0, __bunwasm_ns0_1.test)"), None);
        assert_eq!(namespace_callee_end("(0, __bunwasm_ns0.test)()"), None);
        assert_eq!(namespace_callee_end("(0, __bunwasm_ns0_1)()"), None);
        // As printed: the call's segment marks the imported name (column 4), then a later
        // token (30); the argument list (25) gets the call's original position.
        let fixed = fix("(0, __bunwasm_ns0_0.test)(\"no body\");", "IACE,0BAAK", "")
            .expect("a call segment");
        assert_eq!(fixed.mappings, "IACE,qBAAA,KAAK");
    }

    #[test]
    fn utf16_columns() {
        assert_eq!(byte_offset("a😀b", 3), Some(5));
        assert_eq!(byte_offset("ab", 2), Some(2));
        assert_eq!(byte_offset("ab", 3), None);
    }
}
