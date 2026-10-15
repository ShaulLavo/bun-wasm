/// `import(...)` in code evaluated as a script (CommonJS) goes through the
/// host's dynamic-import hook, like in ES modules (engine-host.js): the
/// engine would resolve it against the host's own URL.
pub(crate) fn rewrite_dynamic_imports(code: &str, from: &str) -> String {
    rewrite_selected_imports(code, from, None)
}

pub(crate) fn rewrite_selected_imports(code: &str, from: &str, selected: Option<&[usize]>) -> String {
    let spans: Vec<Span> = scan_imports(code)
        .into_iter()
        .filter(|s| s.dynamic)
        .enumerate()
        .filter(|(i, _)| selected.is_none_or(|indices| indices.contains(i)))
        .map(|(_, span)| span)
        .collect();
    if spans.is_empty() {
        return code.to_owned();
    }
    let hook = format!("globalThis.__bunwasm_dynamicImport({})", json_string(from));
    let mut out = String::with_capacity(code.len() + spans.len() * hook.len());
    let mut at = 0;
    for span in spans {
        out.push_str(&code[at..span.start]);
        out.push_str(&hook);
        at = span.end;
    }
    out.push_str(&code[at..]);
    out
}

fn json_string(s: &str) -> String {
    let mut out = String::from('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[derive(Debug, PartialEq)]
pub(crate) struct Span {
    pub start: usize,
    pub end: usize,
    pub specifier: String,
    pub dynamic: bool,
}

/// Find import specifiers in JavaScript: `import ... from "x"`, `import "x"`,
/// `export ... from "x"` (string literal spans) and `import(` calls (the
/// keyword's span). A small lexer that skips strings, template literals,
/// comments and regular expressions; good enough for real code, not a parser.
pub(crate) fn scan_imports(src: &str) -> Vec<Span> {
    let b = src.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    // Whether a `/` here would start a regex (vs. divide).
    let mut regex_ok = true;
    while i < b.len() {
        let c = b[i];
        match c {
            b'"' | b'\'' => {
                i = skip_string(b, i);
                regex_ok = false;
            }
            b'`' => {
                i = skip_template(b, i);
                regex_ok = false;
            }
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            b'/' if regex_ok => {
                i = skip_regex(b, i);
                regex_ok = false;
            }
            c if is_ident_start(c) => {
                let start = i;
                while i < b.len() && is_ident(b[i]) {
                    i += 1;
                }
                let word = &src[start..i];
                let after_dot = start > 0 && prev_non_space(b, start) == Some(b'.');
                if !after_dot && (word == "import" || word == "export") {
                    scan_statement(src, start, i, word == "import", &mut spans);
                }
                regex_ok = matches!(word, "return" | "typeof" | "case" | "do" | "else" | "in" | "of" | "new" | "delete" | "void" | "throw" | "await" | "yield");
            }
            b' ' | b'\t' | b'\n' | b'\r' => i += 1,
            b')' | b']' | b'}' => {
                regex_ok = c == b'}';
                i += 1;
            }
            c if c.is_ascii_digit() => {
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'.' || b[i] == b'_') {
                    i += 1;
                }
                regex_ok = false;
            }
            _ => {
                regex_ok = true;
                i += 1;
            }
        }
    }
    spans
}

/// After an `import`/`export` keyword at [start, kw_end): record its
/// specifier (or the dynamic-import keyword).
fn scan_statement(src: &str, start: usize, kw_end: usize, is_import: bool, spans: &mut Vec<Span>) {
    let b = src.as_bytes();
    let mut j = skip_space(b, kw_end);
    if is_import {
        match b.get(j) {
            Some(b'(') => {
                spans.push(Span { start, end: kw_end, specifier: String::new(), dynamic: true });
                return;
            }
            Some(b'.') => return, // import.meta
            Some(b'"') | Some(b'\'') => {
                push_literal(src, j, spans);
                return;
            }
            _ => {}
        }
    } else if !matches!(b.get(j), Some(b'*') | Some(b'{')) {
        // `export const x = ...` etc.: no specifier.
        return;
    }
    // Find `from "x"` before the statement ends (`;` or a newline after `}`).
    let mut depth = 0i32;
    while j < b.len() {
        match b[j] {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            b';' if depth <= 0 => return,
            b'"' | b'\'' if depth <= 0 => return,
            b'"' | b'\'' => {
                j = skip_string(b, j);
                continue;
            }
            b'f' if depth <= 0
                && src[j..].starts_with("from")
                && !is_ident(*b.get(j + 4).unwrap_or(&b' '))
                && !is_ident(b[j - 1]) =>
            {
                let k = skip_space(b, j + 4);
                if matches!(b.get(k), Some(b'"') | Some(b'\'')) {
                    push_literal(src, k, spans);
                }
                return;
            }
            b'(' | b'=' if depth <= 0 => return,
            _ => {}
        }
        j += 1;
    }
}

fn push_literal(src: &str, quote: usize, spans: &mut Vec<Span>) {
    let end = skip_string(src.as_bytes(), quote);
    let raw = &src[quote + 1..end.saturating_sub(1).max(quote + 1)];
    spans.push(Span { start: quote, end, specifier: unescape(raw), dynamic: false });
}

fn unescape(s: &str) -> String {
    if !s.contains('\\') {
        return s.to_owned();
    }
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(n) = chars.next() {
                out.push(n);
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c == b'$' || c >= 0x80
}

fn is_ident(c: u8) -> bool {
    is_ident_start(c) || c.is_ascii_digit()
}

fn skip_space(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// The previous non-blank byte on the same line (a `.` there makes
/// `import` a property name; one at the end of a comment line doesn't).
fn prev_non_space(b: &[u8], mut i: usize) -> Option<u8> {
    while i > 0 {
        i -= 1;
        match b[i] {
            b' ' | b'\t' => continue,
            b'\n' => return None,
            c => return Some(c),
        }
    }
    None
}

fn skip_string(b: &[u8], start: usize) -> usize {
    let quote = b[start];
    let mut i = start + 1;
    while i < b.len() && b[i] != quote && b[i] != b'\n' {
        i += if b[i] == b'\\' { 2 } else { 1 };
    }
    (i + 1).min(b.len())
}

fn skip_template(b: &[u8], start: usize) -> usize {
    let mut i = start + 1;
    while i < b.len() && b[i] != b'`' {
        if b[i] == b'\\' {
            i += 2;
            continue;
        }
        // `${ ... }` may contain anything, including nested templates.
        if b[i] == b'$' && b.get(i + 1) == Some(&b'{') {
            let mut depth = 0;
            i += 1;
            while i < b.len() {
                match b[i] {
                    b'{' => depth += 1,
                    b'}' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    b'`' => i = skip_template(b, i) - 1,
                    b'"' | b'\'' => i = skip_string(b, i) - 1,
                    _ => {}
                }
                i += 1;
            }
        }
        i += 1;
    }
    (i + 1).min(b.len())
}

fn skip_regex(b: &[u8], start: usize) -> usize {
    let mut i = start + 1;
    let mut in_class = false;
    while i < b.len() && b[i] != b'\n' {
        match b[i] {
            b'\\' => i += 1,
            b'[' => in_class = true,
            b']' => in_class = false,
            b'/' if !in_class => break,
            _ => {}
        }
        i += 1;
    }
    i += 1;
    while i < b.len() && b[i].is_ascii_alphabetic() {
        i += 1;
    }
    i.min(b.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn specs(src: &str) -> Vec<(String, bool)> {
        scan_imports(src).into_iter().map(|s| (if s.dynamic { "import(".into() } else { s.specifier }, s.dynamic)).collect()
    }

    #[test]
    fn finds_specifiers() {
        let src = r#"import a, { b } from "./a.js";
import * as ns from './ns';
import "side-effect";
export { x } from "./x";
export * from "./star";
export const y = 1;
const s = "import z from 'nope'";
// import q from "comment"
const r = /from "re"/g;
const t = `import ${x} from "tpl"`;
const d = await import("./dyn.js");
import.meta.url;
foo.import("x");
"#;
        assert_eq!(
            specs(src),
            vec![
                ("./a.js".into(), false),
                ("./ns".into(), false),
                ("side-effect".into(), false),
                ("./x".into(), false),
                ("./star".into(), false),
                ("import(".into(), true),
            ]
        );
    }

    #[test]
    fn after_prologue_and_comment() {
        let src = "globalThis.__bunwasm_meta(import.meta, \"/index.mjs\"); // Real npm packages (vendored, unmodified): CJS, ESM, `exports` maps.\nimport ms from \"ms\";\nimport semver from \"semver\";\n";
        assert_eq!(specs(src), vec![("ms".into(), false), ("semver".into(), false)]);
    }

}
