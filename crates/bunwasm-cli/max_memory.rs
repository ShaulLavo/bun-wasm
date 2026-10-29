//! The wasm32 linear-memory maximum of every Bun guest (docs/memory-ceiling.md).
//! `max-memory.txt` is its one authority; this file is its only Rust reader, shared by the
//! guest build scripts and the native host through `#[path]`.

/// Bytes: a whole number of pages, at most 2 GiB. Above that, browser hosts would see
/// addresses as negative i32 values (docs/memory-ceiling.md, stage 3).
pub const MAX_MEMORY_BYTES: u64 = parse(include_str!("max-memory.txt"));

const _: () = assert!(
    MAX_MEMORY_BYTES > 0 && MAX_MEMORY_BYTES % 65_536 == 0 && MAX_MEMORY_BYTES <= 1 << 31,
    "max-memory.txt must be a page multiple in (0, 2 GiB]"
);

/// One line of decimal digits. Anything else fails the build.
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
        index += 1;
    }
    value
}
