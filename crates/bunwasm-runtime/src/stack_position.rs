//! Stack constructor-column adjustment without transferring the source line.

fn line_tail(source: &str, line: usize) -> Option<&str> {
    let mut tail = source;
    for _ in 0..line.checked_sub(1)? {
        tail = tail.split_once('\n')?.1;
    }
    (!tail.is_empty()).then_some(tail)
}

fn line_chars(source: &str) -> impl Iterator<Item = char> {
    source
        .char_indices()
        .take_while(|&(index, c)| {
            c != '\n' && !(c == '\r' && source.as_bytes().get(index + 1) == Some(&b'\n'))
        })
        .map(|(_, c)| c)
}

fn is_ecmascript_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn new_offset_at(mut chars: impl Iterator<Item = char>, index: usize) -> usize {
    let mut skipped = 0;
    while skipped < index {
        let Some(c) = chars.next() else { return 0 };
        skipped += c.len_utf16();
    }
    if skipped != index
        || chars.next() != Some('n')
        || chars.next() != Some('e')
        || chars.next() != Some('w')
    {
        return 0;
    }
    let spaces = chars.take_while(|&c| is_ecmascript_space(c)).count();
    if spaces == 0 { 0 } else { 3 + spaces }
}

/// UTF-16 length of JS /^new\s+/ at `lineText.slice(column - 1)`.
/// Positive columns visit only the line prefix and the token/whitespace.
/// Negative slice indices need the line length first, as in String.slice.
/// No line String, encoded source bytes, or filename cache is produced.
pub(super) fn new_offset(source: &str, line: usize, column: f64) -> usize {
    let Some(tail) = line_tail(source, line) else {
        return 0;
    };
    let start = (column - 1.0).trunc();
    let index = if start < 0.0 {
        let length: usize = line_chars(tail).map(char::len_utf16).sum();
        (length as f64 + start).max(0.0) as usize
    } else {
        start as usize
    };
    new_offset_at(line_chars(tail), index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn ecmascript_whitespace_and_utf16_columns() {
        for space in [
            '\t', '\u{000b}', '\u{000c}', ' ', '\u{00a0}', '\u{1680}', '\u{2000}', '\u{200a}',
            '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
        ] {
            assert_eq!(new_offset(&format!("😀new{space}Error"), 1, 3.0), 4);
        }
        for space in ['\u{0085}', '\u{180e}', '\u{200b}', '\u{2060}'] {
            assert_eq!(new_offset(&format!("new{space}Error"), 1, 1.0), 0);
        }
        assert_eq!(new_offset("😀new Error", 1, 2.0), 0);
        assert_eq!(new_offset("😀new Error", 1, 3.0), 4);
        assert_eq!(new_offset("new\t\u{feff} Error", 1, 1.0), 6);
    }

    #[test]
    fn slice_indices_and_line_boundaries() {
        assert_eq!(new_offset("new Error", 1, f64::NAN), 4);
        assert_eq!(new_offset("new Error", 1, f64::NEG_INFINITY), 4);
        assert_eq!(new_offset("new Error", 1, f64::INFINITY), 0);
        assert_eq!(new_offset("new Error", 1, 1.9), 4);
        assert_eq!(new_offset("xxnew Error", 1, -8.0), 4);
        assert_eq!(new_offset("new Error", 1, 0.0), 0);
        assert_eq!(new_offset("new Error", 1, 200.0), 0);
        assert_eq!(new_offset("new\r\nnew\r", 1, 1.0), 0);
        assert_eq!(new_offset("new\r\nnew\r", 2, 1.0), 4);
        assert_eq!(new_offset("new\r\nnew\r", 3, 1.0), 0);
        assert_eq!(new_offset("\nnew Error\n", 2, 1.0), 4);
        assert_eq!(new_offset("new Error\n", 2, 1.0), 0);
        assert_eq!(new_offset("new Error", 0, 1.0), 0);
    }

    #[test]
    fn positive_column_work_does_not_visit_the_minified_tail() {
        let line = format!("/*😀*/new \tError();/*{}*/", "x".repeat(4 * 1024 * 1024));
        let visited = Cell::new(0);
        let chars = line_chars(&line).inspect(|_| visited.set(visited.get() + 1));
        assert_eq!(new_offset_at(chars, 6), 5);
        assert_eq!(visited.get(), 11);
        assert_eq!(new_offset(&line, 1, 7.0), 5);
        assert_eq!(
            new_offset(&format!("new Error{}", "x".repeat(4 * 1024 * 1024)), 1, 1.0),
            4
        );
    }
}
