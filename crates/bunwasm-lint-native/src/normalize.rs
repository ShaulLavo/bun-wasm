//! `Bun__normalizeUTF16` for Bun's Rust (`bun_core::strings::normalize`). Bun implements it with
//! ICU in `src/jsc/bindings/bun_icu_normalize.cpp`. ICU's NFKC and NFKD load `nfkc.nrm`, and
//! referencing it links all of ICU's data (8 MB) into the tools guest, so this uses ICU4X's
//! compiled tables instead.

use std::borrow::Cow;

use icu_normalizer::{ComposingNormalizerBorrowed, DecomposingNormalizerBorrowed};

fn normalize_well_formed(form: u8, text: &[u16]) -> Cow<'_, [u16]> {
    match form {
        0 => ComposingNormalizerBorrowed::new_nfc().normalize_utf16(text),
        1 => DecomposingNormalizerBorrowed::new_nfd().normalize_utf16(text),
        2 => ComposingNormalizerBorrowed::new_nfkc().normalize_utf16(text),
        _ => DecomposingNormalizerBorrowed::new_nfkd().normalize_utf16(text),
    }
}

/// ICU keeps an unpaired surrogate; ICU4X would replace it. A surrogate is a starter that
/// composes with nothing, so normalizing the text on each side of it gives ICU's result.
fn normalize(form: u8, text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut start = 0;
    let mut at = 0;
    while at < text.len() {
        let unit = text[at];
        let is_pair = (0xD800..0xDC00).contains(&unit)
            && text
                .get(at + 1)
                .is_some_and(|next| (0xDC00..0xE000).contains(next));
        if is_pair {
            at += 2;
            continue;
        }
        at += 1;
        if !(0xD800..0xE000).contains(&unit) {
            continue;
        }
        out.extend_from_slice(&normalize_well_formed(form, &text[start..at - 1]));
        out.push(unit);
        start = at;
    }
    out.extend_from_slice(&normalize_well_formed(form, &text[start..]));
    out
}

/// `form`: 0 is NFC, 1 is NFD, 2 is NFKC, 3 is NFKD. Returns the length of the normalized text,
/// which is written to `out` if it fits in `capacity`, or a negative number on failure.
///
/// # Safety
///
/// `text` must be readable for `len` units and `out` writable for `capacity` units.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Bun__normalizeUTF16(
    form: u8,
    text: *const u16,
    len: usize,
    out: *mut u16,
    capacity: usize,
) -> i32 {
    // SAFETY: the caller's contract above.
    let text = unsafe { core::slice::from_raw_parts(text, len) };
    let normalized = normalize(form, text);
    let Ok(length) = i32::try_from(normalized.len()) else {
        return -1;
    };
    if normalized.len() <= capacity {
        // SAFETY: `out` has room for `capacity` units and does not overlap the new vector.
        unsafe { core::ptr::copy_nonoverlapping(normalized.as_ptr(), out, normalized.len()) };
    }
    length
}

#[cfg(test)]
mod tests {
    use super::Bun__normalizeUTF16;

    fn call(form: u8, text: &str, capacity: usize) -> (i32, Vec<u16>) {
        let units: Vec<u16> = text.encode_utf16().collect();
        call_units(form, &units, capacity)
    }

    fn call_units(form: u8, units: &[u16], capacity: usize) -> (i32, Vec<u16>) {
        let mut out = vec![0xFFFF; capacity];
        let length = unsafe {
            Bun__normalizeUTF16(
                form,
                units.as_ptr(),
                units.len(),
                out.as_mut_ptr(),
                capacity,
            )
        };
        (length, out)
    }

    fn normalized(form: u8, text: &str) -> String {
        let (length, out) = call(form, text, 64);
        String::from_utf16(&out[..usize::try_from(length).unwrap()]).unwrap()
    }

    #[test]
    fn each_form_matches_string_prototype_normalize() {
        // "é" as a base letter and a combining accent, then the "ﬁ" ligature.
        let text = "cafe\u{301} \u{fb01}";
        assert_eq!(normalized(0, text), "caf\u{e9} \u{fb01}");
        assert_eq!(normalized(1, "caf\u{e9} \u{fb01}"), "cafe\u{301} \u{fb01}");
        assert_eq!(normalized(2, text), "caf\u{e9} fi");
        assert_eq!(normalized(3, "caf\u{e9} \u{fb01}"), "cafe\u{301} fi");
        // Hangul composes and decomposes by algorithm, and marks are reordered by class.
        assert_eq!(normalized(0, "\u{1112}\u{1161}\u{11ab}"), "\u{d55c}");
        assert_eq!(normalized(1, "\u{d55c}"), "\u{1112}\u{1161}\u{11ab}");
        assert_eq!(normalized(0, "a\u{301}\u{323}"), "\u{1ea1}\u{301}");
    }

    #[test]
    fn a_buffer_that_is_too_small_gets_the_needed_length_and_no_text() {
        let (length, out) = call(1, "\u{e9}\u{e9}", 3);
        assert_eq!(length, 4);
        assert_eq!(out, [0xFFFF; 3]);
        let (length, out) = call(1, "\u{e9}\u{e9}", 4);
        assert_eq!(length, 4);
        assert_eq!(out, [0x65, 0x301, 0x65, 0x301]);
    }

    #[test]
    fn unpaired_surrogates_stay_and_the_text_around_them_is_normalized() {
        let units = [
            0x65, 0x301, 0xD800, 0x65, 0x301, 0xDC00, 0xD83D, 0xDE00, 0x65, 0x301,
        ];
        let (length, out) = call_units(0, &units, 16);
        assert_eq!(length, 7);
        assert_eq!(out[..7], [0xE9, 0xD800, 0xE9, 0xDC00, 0xD83D, 0xDE00, 0xE9]);
    }
}
