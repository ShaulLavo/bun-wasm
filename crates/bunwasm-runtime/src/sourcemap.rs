//! Decoding of source map v3 `mappings` (one source) for mapping stack-trace
//! positions in transpiled code back to the original file.

/// One mapping segment: generated column -> original (line, column), 0-based.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Segment {
    gen_col: u32,
    orig_line: u32,
    orig_col: u32,
}

/// Decoded mappings, indexed by generated line (0-based).
#[derive(Debug, Default)]
pub struct SourceMap {
    lines: Vec<Vec<Segment>>,
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

impl SourceMap {
    pub fn parse(mappings: &str) -> SourceMap {
        let mut lines = Vec::new();
        // Source index, original line and column are relative across the
        // whole string; the generated column resets on every line.
        let (mut orig_line, mut orig_col, mut source) = (0i64, 0i64, 0i64);
        for line_text in mappings.split(';') {
            let mut gen_col = 0i64;
            let mut segments = Vec::new();
            for segment_text in line_text.split(',').filter(|s| !s.is_empty()) {
                let fields = decode_segment(segment_text);
                gen_col += fields[0];
                if fields.len() < 4 {
                    continue;
                }
                source += fields[1];
                orig_line += fields[2];
                orig_col += fields[3];
                let _ = source;
                segments.push(Segment {
                    gen_col: gen_col.max(0) as u32,
                    orig_line: orig_line.max(0) as u32,
                    orig_col: orig_col.max(0) as u32,
                });
            }
            segments.sort_by_key(|s| s.gen_col);
            lines.push(segments);
        }
        SourceMap { lines }
    }

    /// Original (line, column), both 1-based, for a 1-based generated position.
    pub fn lookup(&self, line: u32, col: u32) -> Option<(u32, u32)> {
        let segments = self.lines.get(line.checked_sub(1)? as usize)?;
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
        let map = SourceMap::parse("AAAA,IAAU;EAEJ");
        assert_eq!(map.lookup(1, 1), Some((1, 1)));
        assert_eq!(map.lookup(1, 5), Some((1, 11)));
        assert_eq!(map.lookup(1, 7), Some((1, 13)));
        assert_eq!(map.lookup(2, 3), Some((3, 7)));
        assert_eq!(map.lookup(5, 1), None);
    }
}
