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
pub(crate) fn apply(rule: Rule, line: &str, column: usize) -> usize {
    let Some(unit) = column.checked_sub(1) else {
        return column;
    };
    let Some(offset) = byte_offset(line, unit) else {
        return column;
    };
    match rule {
        Rule::Callee => callee(line.as_bytes(), offset, column),
        Rule::Constructor => constructor(&line.as_bytes()[offset..], column),
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
}
