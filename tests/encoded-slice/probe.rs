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
