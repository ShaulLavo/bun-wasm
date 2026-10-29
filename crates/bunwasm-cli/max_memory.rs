//! The wasm32 linear-memory maximum of every Bun guest (docs/memory-ceiling.md).
//! `max-memory.txt` is its one authority; this file is its only Rust reader, shared by the
//! guest build scripts and the native host through `#[path]`.

/// Bytes: a whole number of pages, at most 2 GiB. Above that, browser hosts would see
/// addresses as negative i32 values (docs/memory-ceiling.md, stage 3).
pub const MAX_MEMORY_BYTES: u64 = parse(include_str!("max-memory.txt"));

const LIMIT: u64 = 1 << 31;

/// One line of decimal bytes, a page multiple in (0, 2 GiB]. Anything else fails the build.
const fn parse(text: &str) -> u64 {
    let bytes = text.as_bytes();
    assert!(
        bytes.len() > 1 && bytes[bytes.len() - 1] == b'\n',
        "max-memory.txt is one line"
    );
    let mut value: u64 = 0;
    let mut index = 0;
    while index < bytes.len() - 1 {
        let digit = bytes[index];
        assert!(digit.is_ascii_digit(), "max-memory.txt holds decimal bytes");
        value = value * 10 + (digit - b'0') as u64;
        // Bounded before the next multiply, so no number of digits can wrap, with or
        // without overflow checks.
        assert!(value <= LIMIT, "max-memory.txt must be at most 2 GiB");
        index += 1;
    }
    assert!(
        value > 0 && value.is_multiple_of(65_536),
        "max-memory.txt must be a positive page multiple"
    );
    value
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn accepts_page_multiples_up_to_2_gib() {
        assert_eq!(parse("65536\n"), 65_536);
        assert_eq!(parse("1073741824\n"), 1 << 30);
        assert_eq!(parse("2147483648\n"), 1 << 31);
    }

    // Runtime calls run the same body as the build-time constant, in the test profile's
    // optimization and overflow-check settings (CI runs `cargo test --release`).
    #[test]
    #[should_panic(expected = "at most 2 GiB")]
    fn a_value_that_would_wrap_u64_is_refused() {
        parse("184467440737095516161073741824\n");
    }

    #[test]
    #[should_panic(expected = "at most 2 GiB")]
    fn one_page_above_2_gib_is_refused() {
        parse("2147549184\n");
    }

    #[test]
    #[should_panic(expected = "positive page multiple")]
    fn a_partial_page_is_refused() {
        parse("1073741825\n");
    }

    #[test]
    #[should_panic(expected = "positive page multiple")]
    fn zero_is_refused() {
        parse("0\n");
    }

    #[test]
    #[should_panic(expected = "decimal bytes")]
    fn hexadecimal_is_refused() {
        parse("0x40000000\n");
    }

    #[test]
    #[should_panic(expected = "one line")]
    fn a_missing_newline_is_refused() {
        parse("1073741824");
    }
}
