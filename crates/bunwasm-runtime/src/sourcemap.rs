//! Decoding of source map v3 `mappings` (one source) for mapping stack-trace
//! positions in transpiled code back to the original file.

use std::cell::RefCell;

/// One mapping segment: generated column -> original (line, column), 0-based.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Segment {
    gen_col: u32,
    orig_line: u32,
    orig_col: u32,
}

/// The text is about a third the size of its decoded form, and most modules
/// never appear in a stack trace.
#[derive(Debug)]
enum Mappings {
    Encoded(Box<str>),
    /// Indexed by generated line (0-based).
    Decoded(Vec<Vec<Segment>>),
}

/// A module's mappings, decoded the first time a position is looked up.
#[derive(Debug)]
pub struct SourceMap {
    mappings: RefCell<Mappings>,
}

fn base64_value(c: u8) -> Option<i64> {
    let v = match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    };
    Some(i64::from(v))
}

/// Decode the base64 VLQ numbers of one segment.
fn decode_segment(text: &str) -> Vec<i64> {
    let mut values = Vec::with_capacity(5);
    let mut value = 0i64;
    let mut shift = 0;
    for c in text.bytes() {
        let Some(digit) = base64_value(c) else { break };
        value |= (digit & 31) << shift;
        if digit & 32 != 0 {
            shift += 5;
            continue;
        }
        // The lowest bit is the sign.
        let magnitude = value >> 1;
        values.push(if value & 1 == 1 {
            -magnitude
        } else {
            magnitude
        });
        value = 0;
        shift = 0;
    }
    values
}

#[derive(Default)]
struct DecoderPosition {
    source: i64,
    line: i64,
    column: i64,
}

fn decode_line(text: &str, position: &mut DecoderPosition) -> Vec<Segment> {
    let mut gen_col = 0i64;
    let mut segments = Vec::new();
    for segment_text in text.split(',').filter(|s| !s.is_empty()) {
        let fields = decode_segment(segment_text);
        gen_col += fields[0];
        if fields.len() < 4 {
            continue;
        }
        position.source += fields[1];
        position.line += fields[2];
        position.column += fields[3];
        segments.push(Segment {
            gen_col: gen_col.max(0) as u32,
            orig_line: position.line.max(0) as u32,
            orig_col: position.column.max(0) as u32,
        });
    }
    segments.sort_by_key(|s| s.gen_col);
    segments
}

fn decode_mappings(mappings: &str) -> Vec<Vec<Segment>> {
    let mut lines = Vec::new();
    // Source index, original line and column are relative across the
    // whole string; the generated column resets on every line.
    let mut position = DecoderPosition::default();
    for line_text in mappings.split(';') {
        lines.push(decode_line(line_text, &mut position));
    }
    lines
}

impl SourceMap {
    pub fn new(mappings: impl Into<Box<str>>) -> SourceMap {
        SourceMap {
            mappings: RefCell::new(Mappings::Encoded(mappings.into())),
        }
    }

    /// Original (line, column), both 1-based, for a 1-based generated position.
    pub fn lookup(&self, line: u32, col: u32) -> Option<(u32, u32)> {
        let mut mappings = self.mappings.borrow_mut();
        if let Mappings::Encoded(text) = &*mappings {
            let lines = decode_mappings(text);
            *mappings = Mappings::Decoded(lines);
        }
        let Mappings::Decoded(lines) = &*mappings else {
            unreachable!("decoded above");
        };
        let segments = lines.get(line.checked_sub(1)? as usize)?;
        let col0 = col.saturating_sub(1);
        // Last segment starting at or before the column; else the first one.
        let index = segments.partition_point(|s| s.gen_col <= col0);
        let segment = if index == 0 {
            segments.first()?
        } else {
            &segments[index - 1]
        };
        // Keep the offset within the segment so carets land on the right token.
        let delta = col0.saturating_sub(segment.gen_col);
        let delta = if index == 0 { 0 } else { delta };
        Some((segment.orig_line + 1, segment.orig_col + delta + 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vlq() {
        assert_eq!(decode_segment("AAAA"), vec![0, 0, 0, 0]);
        assert_eq!(decode_segment("AACA"), vec![0, 0, 1, 0]);
        assert_eq!(decode_segment("D"), vec![-1]);
        assert_eq!(decode_segment("gB"), vec![16]);
    }

    #[test]
    fn lookup() {
        // line 1: col 0 -> (0,0); col 4 -> (0,10). line 2: col 2 -> (2,6).
        let map = SourceMap::new("AAAA,IAAU;EAEJ");
        assert_eq!(map.lookup(1, 1), Some((1, 1)));
        assert_eq!(map.lookup(1, 5), Some((1, 11)));
        assert_eq!(map.lookup(1, 7), Some((1, 13)));
        assert_eq!(map.lookup(2, 3), Some((3, 7)));
        assert_eq!(map.lookup(5, 1), None);
    }

    #[test]
    fn mappings_stay_encoded_until_the_first_lookup() {
        let map = SourceMap::new("AAAA,IAAU;EAEJ");
        assert!(matches!(&*map.mappings.borrow(), Mappings::Encoded(_)));
        assert_eq!(map.lookup(2, 3), Some((3, 7)));
        assert!(matches!(&*map.mappings.borrow(), Mappings::Decoded(_)));
        assert_eq!(map.lookup(1, 5), Some((1, 11)));
    }

    #[test]
    fn segments_on_a_line_are_searched_in_column_order() {
        // The second segment starts before the first on the generated line.
        let map = SourceMap::new("IAAA,DACA");
        assert_eq!(map.lookup(1, 4), Some((2, 1)));
        assert_eq!(map.lookup(1, 5), Some((1, 1)));
    }
}
