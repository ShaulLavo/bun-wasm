//! Emoji properties of strings that ICU4X 2.4.0 does not provide (U2).
//! The tables are generated from Unicode emoji data; see emoji_sequences.rs.
use super::Sink;

#[path = "emoji_sequences.rs"]
pub(super) mod data;

const KEYCAP: u32 = 66;
const MODIFIER: u32 = 67;
const FLAG: u32 = 68;
const TAG: u32 = 69;
const ZWJ: u32 = 70;
pub(super) const SEQUENCES: core::ops::RangeInclusive<u32> = KEYCAP..=ZWJ;

fn emit(sink: Sink, chars: impl IntoIterator<Item = char>) {
    let mut buffer = [0u16; data::MAX_UTF16_UNITS];
    let mut length = 0;
    for ch in chars {
        length += ch.encode_utf16(&mut buffer[length..]).len();
    }
    sink.utf16(&buffer[..length]);
}
fn keycaps(sink: Sink) {
    for &base in data::KEYCAP_BASES {
        emit(sink, [char::from(base), '\u{fe0f}', '\u{20e3}']);
    }
}
fn modifiers(sink: Sink) {
    for &base in data::MODIFIER_BASES {
        for modifier in '\u{1f3fb}'..='\u{1f3ff}' {
            emit(sink, [base, modifier]);
        }
    }
}
fn regional_indicator(letter: u8) -> char {
    // The generator only writes A..=Z.
    char::from_u32(0x1f1e6 + u32::from(letter - b'A')).unwrap_or('\u{fffd}')
}
fn flags(sink: Sink) {
    for pair in data::FLAG_REGIONS.as_chunks::<2>().0 {
        emit(sink, pair.map(regional_indicator));
    }
}
fn lines(sink: Sink, text: &str) {
    for line in text.lines() {
        emit(sink, line.chars());
    }
}

/// Emits the strings of one sequence property. Returns false for any other id.
pub(super) fn sequences(property: u32, sink: Sink) -> bool {
    match property {
        KEYCAP => keycaps(sink),
        MODIFIER => modifiers(sink),
        FLAG => flags(sink),
        TAG => lines(sink, data::TAG_SEQUENCES),
        ZWJ => lines(sink, data::ZWJ_SEQUENCES),
        _ => return false,
    }
    true
}

/// Encodes one Basic_Emoji string from ICU4X data.
pub(super) fn string(sink: Sink, string: &str) {
    emit(sink, string.chars());
}
