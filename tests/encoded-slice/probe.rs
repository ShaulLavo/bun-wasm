const LATIN: EncodedSlice<'static> = EncodedSlice::latin1(b"abcd");
const DETACHED: EncodedSlice<'static> = LATIN.detach_lifetime();

fn check_flags(value: EncodedSlice<'_>, utf8: bool, global: bool, utf16: bool) {
    assert_eq!(value.is_utf8(), utf8);
    assert_eq!(value.is_globally_allocated(), global);
    assert_eq!(value.is_16bit(), utf16);
}

fn high_address(address: usize, flags: u8) {
    let raw = core::ptr::without_provenance(address);
    let mut value = EncodedSlice::from_tagged_ptr(raw, 8);
    if flags & 1 != 0 {
        value.mark(PROBE_UTF8);
    }
    if flags & 2 != 0 {
        value.mark(PROBE_GLOBAL);
    }
    if flags & 4 != 0 {
        value.mark(PROBE_UTF16);
    }
    assert_eq!(
        value.untagged_ptr(),
        raw,
        "address {address:#x}, flags {flags}"
    );
    check_flags(value, flags & 1 != 0, flags & 2 != 0, flags & 4 != 0);
    assert_eq!(value.trunc(3).untagged_ptr(), raw);
    assert_eq!(value.trunc(3).len, 3);
    check_flags(
        value.trunc(3),
        flags & 1 != 0,
        flags & 2 != 0,
        flags & 4 != 0,
    );
    assert_eq!(value.detach_lifetime().untagged_ptr(), raw);
    check_flags(
        value.detach_lifetime(),
        flags & 1 != 0,
        flags & 2 != 0,
        flags & 4 != 0,
    );
}

#[inline(never)]
extern "C" fn by_value(value: String) -> String {
    value
}

fn ffi_roundtrip() {
    let words = [65u16, 66, 67];
    let values = [
        String::ascii(b"abc"),
        String::borrow_utf8(b"abc"),
        String::borrow_utf16(&words),
    ];
    for value in values {
        // The EncodedSlice arm is active for each of these constructors.
        let before = unsafe { value.value.encoded };
        let result = by_value(value);
        assert_eq!(result.tag, Tag::EncodedSlice);
        let after = unsafe { result.value.encoded };
        assert_eq!(after.untagged_ptr(), before.untagged_ptr());
        assert_eq!(after.len, before.len);
        check_flags(
            after,
            before.is_utf8(),
            before.is_globally_allocated(),
            before.is_16bit(),
        );
    }
}

fn global_bytes() {
    for mut value in [EncodedSlice::latin1(b"abc"), EncodedSlice::utf8(b"abc")] {
        value.mark(PROBE_GLOBAL);
        let sub = value.substring_with_len(1, 2);
        assert_eq!(sub.slice(), b"b");
        check_flags(sub, value.is_utf8(), true, false);
    }
}

#[cfg(target_pointer_width = "64")]
fn native_tagged_pointer() {
    let address = 0x1234usize;
    let tagged = (address | (7usize << 61)) as *const u8;
    let value = EncodedSlice::from_tagged_ptr(tagged, 5);
    check_flags(value, true, true, true);
    assert_eq!(value._unsafe_ptr_do_not_use, tagged);
    assert_eq!(value.trunc(2)._unsafe_ptr_do_not_use, tagged);
    assert_eq!(value.detach_lifetime()._unsafe_ptr_do_not_use, tagged);
    assert_eq!(value.untagged_ptr().addr(), address);
    assert_eq!(
        EncodedSlice::untagged(core::ptr::without_provenance(usize::MAX)).addr(),
        (1usize << 53) - 1
    );
}

fn constructors() {
    assert_eq!(LATIN.slice(), b"abcd");
    assert_eq!(DETACHED.slice(), b"abcd");
    assert!(EncodedSlice::EMPTY.is_empty());
    assert_eq!(EncodedSlice::EMPTY.untagged_ptr(), b"".as_ptr());
    check_flags(EncodedSlice::EMPTY, false, false, false);
    assert_eq!(EncodedSlice::EMPTY.slice(), b"");
    assert_eq!(EncodedSlice::EMPTY.byte_slice(), b"");
    assert_eq!(String::EMPTY.tag, Tag::Empty);
    assert_eq!(String::DEAD.tag, Tag::Dead);
    assert_eq!(String::OUT_OF_MEMORY.tag, Tag::OutOfMemory);
    let bytes = b"abcd";
    let words = [65u16, 66, 67, 68];
    let cases = [
        EncodedSlice::latin1(bytes),
        EncodedSlice::utf8(bytes),
        EncodedSlice::utf16(&words),
        EncodedSlice::utf16_global(&words),
    ];
    for (index, value) in cases.into_iter().enumerate() {
        let utf8 = index == 1;
        let utf16 = index >= 2;
        let global = index == 3;
        check_flags(value, utf8, global, utf16);
        check_flags(value.trunc(2), utf8, global, utf16);
        check_flags(value.detach_lifetime(), utf8, global, utf16);
        check_flags(value.substring(1), utf8, global, utf16);
        check_flags(value.substring_with_len(1, 3), utf8, global, utf16);
        assert_eq!(value.substring_with_len(1, 3).len, 2);
        assert_eq!(value.trunc(99).len, 4);
        assert_eq!(value.substring(99).len, 0);
        assert_eq!(value.byte_slice().len(), if utf16 { 8 } else { 4 });
        assert_eq!(
            value.substring(1).untagged_ptr(),
            value.untagged_ptr().wrapping_add(if utf16 { 2 } else { 1 })
        );
    }
    assert_eq!(
        EncodedSlice::utf8(bytes).substring_with_len(1, 3).slice(),
        b"bc"
    );
    assert_eq!(
        EncodedSlice::utf16(&words)
            .substring_with_len(1, 3)
            .utf16_slice(),
        &[66, 67]
    );
}

/// Real bytes above the old 512 MiB boundary (wasm32 only): grow this probe's own linear
/// memory, linked at the guest maximum, place Latin-1, UTF-8 and UTF-16 text there, wrap it in
/// the actual `EncodedSlice` and `String`, read it back, and move it through the WASI host
/// bridge with iovecs, buffers and result cells above the boundary.
#[cfg(target_pointer_width = "32")]
mod high_memory {
    use super::*;
    use core::arch::wasm32::{memory_grow, memory_size};

    const PAGE: usize = 65_536;
    const BOUNDARY: usize = 1 << 29;
    /// `crates/bunwasm-cli/max-memory.txt`, also this probe's `--max-memory`.
    const MAXIMUM: usize = PROBE_MAX_MEMORY;
    const LATIN1: usize = BOUNDARY;
    const UTF8: usize = BOUNDARY + 0x0100_0001;
    const UTF16: usize = BOUNDARY + 0x1000_0002;
    const IOVEC: usize = BOUNDARY + 0x1000_1000;
    const RESULT: usize = BOUNDARY + 0x1000_1010;
    const WRITE: usize = BOUNDARY + 0x1000_2003;
    const READ: usize = BOUNDARY + 0x1000_3001;
    pub const WRITTEN: &[u8] = "high fd_write: caf\u{e9} \u{6771}\u{4eac} \u{2713}\n".as_bytes();
    pub const STDIN: &[u8] = b"high fd_read: bun-wasm\n";

    #[link(wasm_import_module = "wasi_snapshot_preview1")]
    unsafe extern "C" {
        fn fd_write(fd: u32, iovs: usize, iovs_len: u32, written: usize) -> i32;
        fn fd_read(fd: u32, iovs: usize, iovs_len: u32, read: usize) -> i32;
    }

    fn grow_to(bytes: usize) {
        let current = memory_size(0) * PAGE;
        if current >= bytes {
            return;
        }
        let pages = (bytes - current).div_ceil(PAGE);
        assert_ne!(
            memory_grow(0, pages),
            usize::MAX,
            "memory.grow to {bytes:#x} failed under a {MAXIMUM:#x}-byte maximum"
        );
    }

    /// Memory past the heap's break: only this probe writes it, through exposed addresses.
    fn at(address: usize) -> *mut u8 {
        core::ptr::with_exposed_provenance_mut(address)
    }

    fn place(address: usize, bytes: &[u8]) -> &'static [u8] {
        // SAFETY: `address..address + len` was just grown and is owned by this probe alone.
        unsafe {
            at(address).copy_from_nonoverlapping(bytes.as_ptr(), bytes.len());
            core::slice::from_raw_parts(at(address), bytes.len())
        }
    }

    fn place_utf16(address: usize, text: &str) -> &'static [u16] {
        let words: Vec<u16> = text.encode_utf16().collect();
        let bytes: Vec<u8> = words.iter().flat_map(|word| word.to_le_bytes()).collect();
        place(address, &bytes);
        // SAFETY: two-byte aligned and initialized above.
        unsafe { core::slice::from_raw_parts(at(address).cast::<u16>(), words.len()) }
    }

    fn same(value: EncodedSlice<'_>, address: usize, bytes: &[u8]) {
        assert_eq!(value.untagged_ptr().addr(), address, "decoded address");
        assert_eq!(value.byte_slice(), bytes, "bytes read back at {address:#x}");
    }

    fn strings() {
        let latin1 = place(LATIN1, &[b'c', b'a', b'f', 0xe9]);
        let mut value = EncodedSlice::latin1(latin1);
        check_flags(value, false, false, false);
        same(value, LATIN1, latin1);
        value.mark(PROBE_GLOBAL);
        check_flags(value, false, true, false);
        same(value, LATIN1, latin1);
        same(value.substring(1), LATIN1 + 1, &latin1[1..]);
        same(value.trunc(2), LATIN1, &latin1[..2]);
        same(value.detach_lifetime(), LATIN1, latin1);

        let utf8 = place(UTF8, "\u{6771}\u{4eac} \u{2713}".as_bytes());
        let value = EncodedSlice::utf8(utf8);
        check_flags(value, true, false, false);
        same(value, UTF8, utf8);
        same(value.substring_with_len(3, 6), UTF8 + 3, &utf8[3..6]);

        let utf16 = place_utf16(UTF16, "\u{1f98a}\u{e9}");
        let bytes = place(UTF16, &[0x3e, 0xd8, 0x8a, 0xdd, 0xe9, 0x00]);
        for (value, global) in [
            (EncodedSlice::utf16(utf16), false),
            (EncodedSlice::utf16_global(utf16), true),
        ] {
            check_flags(value, false, global, true);
            same(value, UTF16, bytes);
            assert_eq!(value.utf16_slice(), &[0xd83e, 0xdd8a, 0xe9]);
            assert_eq!(value.substring(2).untagged_ptr().addr(), UTF16 + 4);
            assert_eq!(value.substring(2).utf16_slice(), &[0xe9]);
        }

        for value in [
            String::ascii(&latin1[..3]),
            String::borrow_utf8(utf8),
            String::borrow_utf16(utf16),
        ] {
            // SAFETY: each constructor selects the EncodedSlice arm.
            let before = unsafe { value.value.encoded };
            let after = unsafe { by_value(value).value.encoded };
            assert!(before.untagged_ptr().addr() >= BOUNDARY);
            same(after, before.untagged_ptr().addr(), before.byte_slice());
            check_flags(
                after,
                before.is_utf8(),
                before.is_globally_allocated(),
                before.is_16bit(),
            );
        }
    }

    fn place_iovec(buffer: usize, len: usize) {
        let words = [buffer as u32, len as u32];
        place(
            IOVEC,
            &[words[0].to_le_bytes(), words[1].to_le_bytes()].concat(),
        );
    }

    /// The host reads an iovec and its buffer above the boundary and writes its count there.
    fn host_write() {
        let text = EncodedSlice::utf8(place(WRITE, WRITTEN));
        place_iovec(text.untagged_ptr().addr(), text.len);
        // SAFETY: every address names grown memory owned by this probe.
        let errno = unsafe { fd_write(1, IOVEC, 1, RESULT) };
        assert_eq!(errno, 0, "fd_write from {WRITE:#x}");
        let count = unsafe { at(RESULT).cast::<u32>().read() };
        assert_eq!(
            count as usize,
            WRITTEN.len(),
            "fd_write count at {RESULT:#x}"
        );
    }

    /// The host writes stdin into a buffer above the boundary; Bun's string reads it back.
    fn host_read() {
        place_iovec(READ, 64);
        // SAFETY: as above.
        let errno = unsafe { fd_read(0, IOVEC, 1, RESULT) };
        assert_eq!(errno, 0, "fd_read into {READ:#x}");
        let count = unsafe { at(RESULT).cast::<u32>().read() } as usize;
        // SAFETY: the host initialized `count` bytes at READ.
        let read = unsafe { core::slice::from_raw_parts(at(READ), count) };
        same(EncodedSlice::latin1(read), READ, STDIN);
    }

    pub fn run() {
        assert!(
            memory_size(0) * PAGE <= BOUNDARY,
            "the probe heap already reaches 512 MiB"
        );
        grow_to(READ + PAGE);
        strings();
        host_write();
        host_read();
    }

    /// Last: once memory is at its maximum, the heap cannot grow either.
    pub fn maximum() {
        grow_to(MAXIMUM);
        let top = place(MAXIMUM - 4, b"top!");
        same(EncodedSlice::latin1(top), MAXIMUM - 4, b"top!");
        assert_eq!(memory_size(0) * PAGE, MAXIMUM);
        assert_eq!(
            memory_grow(0, 1),
            usize::MAX,
            "memory grew past the maximum"
        );
        println!(
            "PASS: real Latin-1, UTF-8 and UTF-16 strings at {LATIN1:#x}..{:#x}, host fd_write/fd_read above 512 MiB, maximum {MAXIMUM:#x}",
            MAXIMUM - 1
        );
    }
}

fn layout() {
    assert_eq!(core::mem::offset_of!(EncodedSlice, len), size_of::<usize>());
    assert_eq!(core::mem::offset_of!(String, value), align_of::<String>());
    #[cfg(target_pointer_width = "64")]
    assert_eq!(
        (
            size_of::<EncodedSlice>(),
            align_of::<EncodedSlice>(),
            size_of::<String>(),
            align_of::<String>()
        ),
        (16, 8, 24, 8)
    );
    println!(
        "pointer={} EncodedSlice={}/{} String={}/{} StringImpl={}/{}",
        usize::BITS,
        size_of::<EncodedSlice>(),
        align_of::<EncodedSlice>(),
        size_of::<String>(),
        align_of::<String>(),
        size_of::<StringImpl>(),
        align_of::<StringImpl>()
    );
}

fn main() {
    layout();
    // First, before the heap can grow: the heap break must stay below the boundary.
    #[cfg(target_pointer_width = "32")]
    high_memory::run();
    constructors();
    ffi_roundtrip();
    global_bytes();
    #[cfg(target_pointer_width = "64")]
    native_tagged_pointer();
    for address in [
        0,
        1,
        0x1fff_fff0,
        0x1fff_ffff,
        0x2000_0000,
        0x2000_0001,
        0x7fff_ffff,
        0x8000_0000,
        0x8000_0001,
        0xffff_fff0,
        0xffff_ffff,
    ] {
        for flags in 0..8 {
            high_address(address, flags);
        }
    }
    // The top of the maximum is usable, and nothing past it is.
    #[cfg(target_pointer_width = "32")]
    high_memory::maximum();
    #[cfg(target_pointer_width = "32")]
    assert_eq!(
        (
            size_of::<EncodedSlice>(),
            align_of::<EncodedSlice>(),
            size_of::<String>(),
            align_of::<String>()
        ),
        (12, 4, 16, 4)
    );
    println!(
        "PASS: constructors, substrings, truncation, detach, sentinels, 88 synthetic pointer/flag cases"
    );
}
