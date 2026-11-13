//! Decoding of source map v3 `mappings` for mapping stack-trace positions in
//! transpiled code back to the original file. Source indices do not select files.

use std::cell::Cell;

/// One mapping segment: generated column -> original (line, column), 0-based.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Segment {
    gen_col: u32,
    orig_line: u32,
    orig_col: u32,
}

#[derive(Clone, Copy, Debug, Default)]
struct DecoderPosition {
    source: i64,
    line: i64,
    column: i64,
}

/// Decoder state immediately before a generated line, not after its segments.
#[derive(Clone, Copy, Debug, Default)]
struct LineCursor {
    line: u32,
    offset: usize,
    position: DecoderPosition,
}

#[derive(Clone, Copy, Debug)]
struct Lookup {
    line: u32,
    col: u32,
    result: Option<(u32, u32)>,
}

/// Encoded mappings with constant-size lookup state. Forward queries reuse the
/// line cursor; backward queries restart. An identical query uses the last result.
#[derive(Debug)]
pub struct SourceMap {
    mappings: Box<str>,
    cursor: Cell<LineCursor>,
    last: Cell<Option<Lookup>>,
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

/// Only the first four fields affect positions. Consume the remaining fields to
/// retain the decoder's handling of invalid characters and unfinished VLQs.
fn decode_segment(text: &str) -> ([i64; 4], usize) {
    let mut fields = [0; 4];
    let mut len = 0;
    let mut value = 0i64;
    let mut shift = 0;
    for c in text.bytes() {
        let Some(digit) = base64_value(c) else { break };
        value |= (digit & 31) << shift;
        if digit & 32 != 0 {
            shift += 5;
            continue;
        }
        let magnitude = value >> 1;
        let decoded = if value & 1 == 1 {
            -magnitude
        } else {
            magnitude
        };
        if len < fields.len() {
            fields[len] = decoded;
            len += 1;
        }
        value = 0;
        shift = 0;
    }
    (fields, len)
}

fn prefer(next: Segment, current: Segment, col: u32) -> bool {
    if next.gen_col <= col {
        return current.gen_col > col || next.gen_col >= current.gen_col;
    }
    current.gen_col > col && next.gen_col < current.gen_col
}

fn lookup_line(text: &str, position: &mut DecoderPosition, col: u32) -> Option<Segment> {
    let mut gen_col = 0i64;
    let mut selected = None;
    for segment_text in text.split(',').filter(|s| !s.is_empty()) {
        let (fields, len) = decode_segment(segment_text);
        assert!(len > 0, "source-map segment has no complete VLQ");
        gen_col += fields[0];
        if len < 4 {
            continue;
        }
        position.source += fields[1];
        position.line += fields[2];
        position.column += fields[3];
        let next = Segment {
            gen_col: gen_col.max(0) as u32,
            orig_line: position.line.max(0) as u32,
            orig_col: position.column.max(0) as u32,
        };
        // Stable sorting picks the last equal column for a match, but the first
        // equal minimum column for the fallback before all mapped segments.
        if selected.is_none_or(|current| prefer(next, current, col)) {
            selected = Some(next);
        }
    }
    selected
}

impl SourceMap {
    pub fn new(mappings: impl Into<Box<str>>) -> SourceMap {
        SourceMap {
            mappings: mappings.into(),
            cursor: Cell::default(),
            last: Cell::default(),
        }
    }

    fn line_cursor(&self, line: u32) -> Option<LineCursor> {
        let mut cursor = self.cursor.get();
        if cursor.line > line {
            cursor = LineCursor::default();
        }
        while cursor.line < line {
            let rest = &self.mappings[cursor.offset..];
            let Some(end) = rest.find(';') else {
                self.cursor.set(cursor);
                return None;
            };
            lookup_line(&rest[..end], &mut cursor.position, 0);
            cursor.offset += end + 1;
            cursor.line += 1;
        }
        self.cursor.set(cursor);
        Some(cursor)
    }

    /// Original (line, column), both 1-based, for a 1-based generated position.
    pub fn lookup(&self, line: u32, col: u32) -> Option<(u32, u32)> {
        let line0 = line.checked_sub(1)?;
        if let Some(last) = self
            .last
            .get()
            .filter(|last| last.line == line && last.col == col)
        {
            return last.result;
        }
        let result = self.lookup_position(line0, col.saturating_sub(1));
        self.last.set(Some(Lookup { line, col, result }));
        result
    }

    fn lookup_position(&self, line: u32, col: u32) -> Option<(u32, u32)> {
        let mut cursor = self.line_cursor(line)?;
        let rest = &self.mappings[cursor.offset..];
        let text = &rest[..rest.find(';').unwrap_or(rest.len())];
        let segment = lookup_line(text, &mut cursor.position, col)?;
        let delta = col.saturating_sub(segment.gen_col);
        Some((segment.orig_line + 1, segment.orig_col + delta + 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vlq() {
        assert_eq!(decode_segment("AAAA"), ([0, 0, 0, 0], 4));
        assert_eq!(decode_segment("AACA"), ([0, 0, 1, 0], 4));
        assert_eq!(decode_segment("D"), ([-1, 0, 0, 0], 1));
        assert_eq!(decode_segment("gB"), ([16, 0, 0, 0], 1));
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
    fn irrelevant_suffix_is_not_decoded_and_line_zero_returns_early() {
        let map = SourceMap::new("AAAA;!");
        assert_eq!(map.lookup(0, 1), None);
        assert_eq!(map.lookup(1, 1), Some((1, 1)));
        assert_eq!(&*map.mappings, "AAAA;!");
        assert_eq!(map.cursor.get().line, 0);
    }

    #[test]
    fn stable_column_order_and_first_segment_fallback() {
        let map = SourceMap::new("IAAA,DACA,AACA");
        assert_eq!(map.lookup(1, 1), Some((2, 1)));
        assert_eq!(map.lookup(1, 4), Some((3, 1)));
        assert_eq!(map.lookup(1, 5), Some((1, 1)));
    }

    // The former allocating decoder is an independent test oracle. Production
    // lookup must not collect fields, segments or lines into vectors.
    fn oracle_fields(text: &str) -> Vec<i64> {
        let mut fields = Vec::with_capacity(5);
        let (mut value, mut shift) = (0i64, 0);
        for c in text.bytes() {
            let Some(digit) = base64_value(c) else { break };
            value |= (digit & 31) << shift;
            if digit & 32 != 0 {
                shift += 5;
                continue;
            }
            let magnitude = value >> 1;
            fields.push(if value & 1 == 1 {
                -magnitude
            } else {
                magnitude
            });
            value = 0;
            shift = 0;
        }
        fields
    }

    fn oracle_line(text: &str, position: &mut DecoderPosition) -> Vec<Segment> {
        let mut gen_col = 0i64;
        let mut segments = Vec::new();
        for text in text.split(',').filter(|s| !s.is_empty()) {
            let fields = oracle_fields(text);
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

    fn oracle_lookup(lines: &[Vec<Segment>], line: u32, col: u32) -> Option<(u32, u32)> {
        let segments = lines.get(line.checked_sub(1)? as usize)?;
        let col = col.saturating_sub(1);
        let index = segments.partition_point(|s| s.gen_col <= col);
        let segment = segments.get(index.saturating_sub(1))?;
        let delta = if index == 0 { 0 } else { col - segment.gen_col };
        Some((segment.orig_line + 1, segment.orig_col + delta + 1))
    }

    fn oracle_mappings(text: &str) -> Vec<Vec<Segment>> {
        let mut position = DecoderPosition::default();
        text.split(';')
            .map(|text| oracle_line(text, &mut position))
            .collect()
    }

    fn assert_parity(text: &str) {
        let lines = oracle_mappings(text);
        let map = SourceMap::new(text);
        for line in [0, 9, 1, 3, 2, 8, 4, 1, 5, 6, 7, u32::MAX] {
            for col in [0, 1, 2, 4, 5, 32, 128] {
                assert_eq!(
                    map.lookup(line, col),
                    oracle_lookup(&lines, line, col),
                    "{text} at {line}:{col}"
                );
                assert_eq!(map.lookup(line, col), oracle_lookup(&lines, line, col));
            }
        }
    }

    fn encode(fields: &[i64]) -> String {
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut text = String::new();
        for field in fields {
            let mut value = (field.unsigned_abs() << 1) | u64::from(*field < 0);
            while value >= 32 {
                text.push(alphabet[((value & 31) | 32) as usize] as char);
                value >>= 5;
            }
            text.push(alphabet[value as usize] as char);
        }
        text
    }

    #[test]
    fn partial_fields_invalid_characters_and_delta_boundaries_match_the_oracle() {
        for text in [
            "",
            ";;;",
            ",,;A;AA;AAA",
            "AAAA!,AACA?;AAAg",
            "IAAA,DACA,AACA;ADCD",
            "AAAAA,gBACEg,AADH",
        ] {
            assert_parity(text);
        }
        let boundaries = encode(&[4294967296, 4294967296, -1, -1, 999]);
        let recovery = encode(&[-4294967297, -4294967296, 4294967299, 4294967299]);
        assert_parity(&format!("{boundaries};{recovery};DADD;AACG"));
        assert_eq!(decode_segment("B"), ([0, 0, 0, 0], 1));
        assert_eq!(decode_segment("AAAg"), ([0, 0, 0, 0], 3));
    }

    fn generated_map(seed: &mut u64) -> String {
        let mut text = String::new();
        for index in 0..96 {
            let fields: Vec<_> = (0..5)
                .map(|_| {
                    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                    ((*seed >> 32) % 41) as i64 - 20
                })
                .collect();
            let len = 1 + (*seed % 5) as usize;
            text.push_str(&encode(&fields[..len]));
            text.push(if index % 12 == 11 { ';' } else { ',' });
        }
        text
    }

    #[test]
    fn generated_unsorted_multisource_maps_match_the_oracle_in_any_query_order() {
        let mut seed = 1;
        for _ in 0..256 {
            assert_parity(&generated_map(&mut seed));
        }
    }

    #[test]
    fn malformed_segments_still_panic_when_reached() {
        use std::panic::{AssertUnwindSafe, catch_unwind};
        for text in ["!", "g", "AAAA;g", "AAAA,!"] {
            let map = SourceMap::new(text);
            let line = if text.contains(';') { 2 } else { 1 };
            assert!(catch_unwind(AssertUnwindSafe(|| map.lookup(line, 1))).is_err());
            assert!(catch_unwind(|| oracle_mappings(text)).is_err());
        }
    }

    fn assert_extreme_queries(text: &str) {
        use std::panic::{AssertUnwindSafe, catch_unwind};
        let lines = oracle_mappings(text);
        let map = SourceMap::new(text);
        for col in [0, u32::MAX - 1, u32::MAX] {
            let actual = catch_unwind(AssertUnwindSafe(|| map.lookup(2, col)));
            let expected = catch_unwind(|| oracle_lookup(&lines, 2, col));
            assert_eq!(actual.ok(), expected.ok());
        }
    }

    #[test]
    fn extreme_query_and_original_position_arithmetic_match_the_oracle() {
        for text in ["AAAA", "AAAC", "AADH", "AAAA;AA+/////H+/////H"] {
            assert_extreme_queries(text);
        }
    }

    #[test]
    #[cfg(debug_assertions)]
    fn overflowing_vlq_and_deltas_retain_debug_rejection() {
        use std::panic::{AssertUnwindSafe, catch_unwind};
        let vlq = "g".repeat(13) + "A";
        assert!(catch_unwind(|| decode_segment(&vlq)).is_err());
        assert!(catch_unwind(|| oracle_fields(&vlq)).is_err());
        let delta = encode(&[i64::MAX / 2, i64::MAX / 2, i64::MAX / 2, i64::MAX / 2]);
        let text = format!("{delta},{delta},{delta}");
        let map = SourceMap::new(text.as_str());
        assert!(catch_unwind(AssertUnwindSafe(|| map.lookup(1, 1))).is_err());
        assert!(catch_unwind(|| oracle_mappings(&text)).is_err());
    }
}
