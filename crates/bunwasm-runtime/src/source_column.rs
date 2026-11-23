//! Stack-frame column fixups that read one source line where it is stored.
//!
//! `src/js/inspect.js` moves an engine's reported column to the one Bun prints: JSC reports a
//! call at its open paren and SpiderMonkey reports a constructor call at `new`. Both only look at
//! a few characters around the column, but the rule used to receive the whole line as a
//! JavaScript string. A minified bundle keeps its code on one line (Next's compiled
//! `@vercel/nft` has a 126,000-character line), so every frame copied that line into the engine,
//! and reading `error.stack` dominated `next build` on JSC. These rules run on the stored line
//! instead and return only the column. `inspect.js` keeps the same rules over text for sources
//! that live in JavaScript (hot-run modules) and for hosts without this native.
//!
//! Columns are 1-based UTF-16 code-unit offsets, as in stack text. Each rule matches the
//! JavaScript it replaces exactly, including a column outside the line, which stays unchanged.

use std::collections::HashMap;
use std::rc::Rc;

/// Lines up to this byte length are cheap to scan directly without allocating a checkpoint table.
const SMALL_LINE_BYTES: usize = 256;
/// UTF-16 code units between stored byte-offset checkpoints on long non-ASCII lines.
const CHECKPOINT_STRIDE: usize = 128;
/// Maximum number of recently indexed files retained per `source_generation`.
const MAX_CACHED_SOURCES: usize = 8;

/// The column rules `sourceColumn` applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rule {
    /// JSC: a column at `(` moves to the start of the identifier just before it.
    Callee,
    /// SpiderMonkey: a column at `new` followed by spaces or tabs and an identifier moves past
    /// the keyword and the spaces.
    Constructor,
}

impl Rule {
    pub(crate) fn parse(name: &str) -> Option<Self> {
        match name {
            "callee" => Some(Self::Callee),
            "constructor" => Some(Self::Constructor),
            _ => None,
        }
    }
}

/// The column Bun prints for `column` (1-based) on `line`.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn apply(rule: Rule, line: &str, column: usize) -> usize {
    let Some(unit) = column.checked_sub(1) else {
        return column;
    };
    let Some(offset) = byte_offset(line, unit) else {
        return column;
    };
    apply_at_offset(rule, line.as_bytes(), offset, column)
}

fn apply_at_offset(rule: Rule, bytes: &[u8], offset: usize, column: usize) -> usize {
    match rule {
        Rule::Callee => callee(bytes, offset, column),
        Rule::Constructor => constructor(&bytes[offset..], column),
    }
}

/// Cached line boundaries and lazy per-line UTF-16 checkpoints for one loaded source.
pub(crate) struct SourceIndex {
    /// `[start, end)` byte range of each line (0-based), matching `str::lines()`.
    lines: Vec<(usize, usize)>,
    /// Lazy UTF-16 offset tables for long lines (`len > SMALL_LINE_BYTES`).
    utf16: HashMap<usize, LineUtf16>,
}

impl SourceIndex {
    pub(crate) fn new(text: &str) -> Self {
        Self {
            lines: line_ranges(text),
            utf16: HashMap::new(),
        }
    }

    pub(crate) fn line<'a>(&self, text: &'a str, index: usize) -> Option<&'a str> {
        let &(start, end) = self.lines.get(index)?;
        Some(&text[start..end])
    }

    pub(crate) fn apply_column(
        &mut self,
        text: &str,
        rule: Rule,
        line_index: usize,
        column: usize,
    ) -> Option<usize> {
        let &(start, end) = self.lines.get(line_index)?;
        let line = &text[start..end];
        let Some(unit) = column.checked_sub(1) else {
            return Some(column);
        };
        let offset = if line.len() <= SMALL_LINE_BYTES {
            byte_offset(line, unit)
        } else {
            self.utf16
                .entry(line_index)
                .or_insert_with(|| LineUtf16::new(line))
                .byte_offset(line, unit)
        };
        let Some(offset) = offset else {
            return Some(column);
        };
        Some(apply_at_offset(rule, line.as_bytes(), offset, column))
    }
}

/// Bounded LRU cache of [`SourceIndex`] values keyed by `(file, generation, text pointer)`.
#[derive(Default)]
pub(crate) struct SourceIndexCache {
    entries: Vec<CachedSource>,
}

struct CachedSource {
    file: String,
    generation: u32,
    from_original_file: bool,
    text: Rc<str>,
    index: SourceIndex,
}

impl SourceIndexCache {
    pub(crate) fn clear(&mut self) {
        self.entries.clear();
    }

    pub(crate) fn cached_original_text(&self, file: &str, generation: u32) -> Option<Rc<str>> {
        self.entries
            .iter()
            .find(|e| e.from_original_file && e.generation == generation && e.file == file)
            .map(|e| e.text.clone())
    }

    pub(crate) fn get_or_insert(
        &mut self,
        file: &str,
        generation: u32,
        from_original_file: bool,
        text: &Rc<str>,
    ) -> &mut SourceIndex {
        if let Some(pos) = self.entries.iter().position(|e| {
            e.generation == generation
                && e.from_original_file == from_original_file
                && e.file == file
                && Rc::ptr_eq(&e.text, text)
        }) {
            if pos != 0 {
                self.entries[..=pos].rotate_right(1);
            }
            return &mut self.entries[0].index;
        }
        if let Some(pos) = self.entries.iter().position(|e| e.file == file) {
            self.entries.remove(pos);
        } else if self.entries.len() >= MAX_CACHED_SOURCES {
            self.entries.pop();
        }
        self.entries.insert(
            0,
            CachedSource {
                file: file.to_owned(),
                generation,
                from_original_file,
                text: text.clone(),
                index: SourceIndex::new(text),
            },
        );
        &mut self.entries[0].index
    }
}

/// `[start, end)` byte spans of each line in `text`, matching `str::lines()` exactly.
fn line_ranges(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    while start < bytes.len() {
        match bytes[start..].iter().position(|&b| b == b'\n') {
            Some(rel) => {
                let nl = start + rel;
                let end = if nl > start && bytes[nl - 1] == b'\r' {
                    nl - 1
                } else {
                    nl
                };
                lines.push((start, end));
                start = nl + 1;
            }
            None => {
                lines.push((start, bytes.len()));
                break;
            }
        }
    }
    lines
}

enum LineUtf16 {
    /// Every byte is ASCII, so UTF-16 code unit `u` is byte `u`.
    Ascii,
    /// Checkpoints `(utf16_unit, byte_offset)` spaced every `CHECKPOINT_STRIDE` UTF-16 units.
    /// Invariant: for every `k`, `k * CHECKPOINT_STRIDE <= checkpoints[k].0 <= k * CHECKPOINT_STRIDE + 1`.
    Checkpoints {
        total_units: usize,
        checkpoints: Vec<(usize, usize)>,
    },
}

impl LineUtf16 {
    fn new(line: &str) -> Self {
        if line.is_ascii() {
            return Self::Ascii;
        }
        let mut checkpoints = Vec::with_capacity(line.len() / CHECKPOINT_STRIDE + 1);
        checkpoints.push((0, 0));
        let mut units = 0;
        let mut next_mark = CHECKPOINT_STRIDE;
        for (byte, ch) in line.char_indices() {
            if units >= next_mark {
                checkpoints.push((units, byte));
                next_mark = checkpoints.len() * CHECKPOINT_STRIDE;
            }
            units += ch.len_utf16();
        }
        Self::Checkpoints {
            total_units: units,
            checkpoints,
        }
    }

    fn byte_offset(&self, line: &str, unit: usize) -> Option<usize> {
        match self {
            Self::Ascii => (unit < line.len()).then_some(unit),
            Self::Checkpoints {
                total_units,
                checkpoints,
            } => {
                if unit >= *total_units {
                    return None;
                }
                let mut idx = (unit / CHECKPOINT_STRIDE).min(checkpoints.len() - 1);
                if checkpoints[idx].0 > unit {
                    idx -= 1;
                }
                let (mut units, start_byte) = checkpoints[idx];
                for (rel, ch) in line[start_byte..].char_indices() {
                    if units == unit {
                        return Some(start_byte + rel);
                    }
                    units += ch.len_utf16();
                    if units > unit {
                        return None;
                    }
                }
                None
            }
        }
    }
}

/// `text[column - 1] === "("`, then the identifier characters (`[\w$]`) before it.
fn callee(bytes: &[u8], offset: usize, column: usize) -> usize {
    if bytes.get(offset) != Some(&b'(') {
        return column;
    }
    // Identifier characters are ASCII, one byte and one code unit each, so counting bytes
    // backwards counts code units. Any byte of a non-ASCII character ends the run, as its
    // UTF-16 units are not `[\w$]` either.
    let name = bytes[..offset]
        .iter()
        .rev()
        .take_while(|&&byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$')
        .count();
    if name == 0 { column } else { column - name }
}

/// `/^new[ \t]+(?=[$A-Z_a-z])/` at the column; on a match the column moves past it.
fn constructor(rest: &[u8], column: usize) -> usize {
    let Some(after) = rest.strip_prefix(b"new") else {
        return column;
    };
    let spaces = after
        .iter()
        .take_while(|&&byte| byte == b' ' || byte == b'\t')
        .count();
    let starts_name = after
        .get(spaces)
        .is_some_and(|&byte| byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$');
    if spaces == 0 || !starts_name {
        return column;
    }
    column + 3 + spaces
}

/// The byte offset of UTF-16 code unit `unit` in `line`. None when `unit` is past the last
/// unit or falls on the second unit of a surrogate pair, where JavaScript would read a lone
/// surrogate that matches no rule.
fn byte_offset(line: &str, unit: usize) -> Option<usize> {
    let bytes = line.as_bytes();
    // Most code is ASCII up to the column: there a byte is a code unit.
    if unit < bytes.len() && bytes[..unit].is_ascii() {
        return Some(unit);
    }
    let mut units = 0;
    for (offset, ch) in line.char_indices() {
        if units == unit {
            return Some(offset);
        }
        units += ch.len_utf16();
        if units > unit {
            return None;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // The JavaScript rules this module replaces (inspect.js), over UTF-16 code units.
    fn callee_js(text: &str, column: usize) -> usize {
        let units: Vec<u16> = text.encode_utf16().collect();
        if column == 0 || units.get(column - 1) != Some(&u16::from(b'(')) {
            return column;
        }
        let word = |unit: u16| {
            u8::try_from(unit).is_ok_and(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$')
        };
        let mut start = column - 1;
        while start > 0 && word(units[start - 1]) {
            start -= 1;
        }
        if start < column - 1 {
            start + 1
        } else {
            column
        }
    }

    fn constructor_js(text: &str, column: usize) -> usize {
        let units: Vec<u16> = text.encode_utf16().collect();
        if column == 0 || column - 1 > units.len() {
            return column;
        }
        let rest = String::from_utf16_lossy(&units[column - 1..]);
        let Some(after) = rest.strip_prefix("new") else {
            return column;
        };
        let spaces = after
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .count();
        let next = after[spaces..].chars().next();
        if spaces == 0 || !next.is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$') {
            return column;
        }
        column + 3 + spaces
    }

    const LINES: &[&str] = &[
        "  invoke(",
        "  throw new Error(\"async failure\");",
        "  throw new\t \tError();",
        "  throw newer();",
        "  throw new 1;",
        "  throw new  ;",
        "new Foo",
        "(",
        "a.$b_9(c)",
        "é(x) ηλ(y) 🦊f(z) 🦊(w)",
        "x 🦊 new Thing() 🦊new Other()",
        "",
    ];

    #[test]
    fn rules_match_the_javascript_rules_at_every_column() {
        for line in LINES {
            let units = line.encode_utf16().count();
            for column in 0..=units + 2 {
                assert_eq!(
                    apply(Rule::Callee, line, column),
                    callee_js(line, column),
                    "callee {line:?} {column}"
                );
                assert_eq!(
                    apply(Rule::Constructor, line, column),
                    constructor_js(line, column),
                    "constructor {line:?} {column}"
                );
            }
        }
    }

    #[test]
    fn rules_move_columns_as_bun_prints_them() {
        assert_eq!(apply(Rule::Callee, "  invoke(", 9), 3);
        assert_eq!(apply(Rule::Callee, "  (x)", 3), 3);
        assert_eq!(apply(Rule::Constructor, "  throw new Error(\"x\");", 9), 13);
        assert_eq!(apply(Rule::Constructor, "  throw newer();", 9), 9);
        assert_eq!(Rule::parse("callee"), Some(Rule::Callee));
        assert_eq!(Rule::parse("pastNew"), None);
    }

    #[test]
    fn a_long_minified_line_is_read_in_place() {
        let line = format!("{};fail(1)", "x".repeat(130_000));
        assert_eq!(apply(Rule::Callee, &line, 130_006), 130_002);
    }

    #[test]
    fn source_index_lines_match_str_lines() {
        let samples = [
            "",
            "\n",
            "\r\n",
            "\r",
            "a",
            "a\n",
            "a\r\n",
            "a\r\rb",
            "a\r\r\n",
            "a\r\nb\nc\r",
            "a\n\n",
            "\n\r\n",
            "a\u{2028}b\u{2029}c\nlast",
        ];
        for sample in samples {
            let index = SourceIndex::new(sample);
            let expected: Vec<&str> = sample.lines().collect();
            let actual: Vec<&str> = (0..expected.len())
                .map(|i| index.line(sample, i).unwrap())
                .collect();
            assert_eq!(actual, expected, "lines for {sample:?}");
            assert_eq!(index.line(sample, expected.len()), None);
        }
    }

    #[test]
    fn indexed_lookup_matches_unindexed_across_checkpoint_boundaries() {
        let ascii_long = format!("{}invoke(1); throw new Error();", "x".repeat(400));
        let surrogate_at_boundary = format!(
            "{}🦊f(1);{}🦊new Thing();{}🦊",
            "a".repeat(CHECKPOINT_STRIDE - 1),
            "b".repeat(CHECKPOINT_STRIDE - 5),
            "c".repeat(CHECKPOINT_STRIDE - 3),
        );
        let all_surrogates = format!("{}f(1)new X()", "🦊".repeat(CHECKPOINT_STRIDE + 5));
        let bmp_and_astral = format!("'é';{}🦊new\tThing();", "f();".repeat(90));
        for line in [
            ascii_long,
            surrogate_at_boundary,
            all_surrogates,
            bmp_and_astral,
        ] {
            assert!(line.len() > SMALL_LINE_BYTES);
            let mut index = SourceIndex::new(&line);
            let units = line.encode_utf16().count();
            for column in 0..=units + 2 {
                assert_eq!(
                    index.apply_column(&line, Rule::Callee, 0, column),
                    Some(callee_js(&line, column)),
                    "indexed callee col {column}"
                );
                assert_eq!(
                    index.apply_column(&line, Rule::Constructor, 0, column),
                    Some(constructor_js(&line, column)),
                    "indexed constructor col {column}"
                );
            }
            assert_eq!(index.utf16.len(), 1);
        }
    }

    #[test]
    fn repeated_lookups_on_long_unicode_line_reuse_index() {
        let calls = 31_500;
        let source = format!("'é';{}", "f();".repeat(calls));
        let mut index = SourceIndex::new(&source);
        for i in 0..calls {
            assert_eq!(
                index.apply_column(&source, Rule::Callee, 0, 6 + 4 * i),
                Some(5 + 4 * i)
            );
        }
        assert_eq!(index.utf16.len(), 1);
    }
}
