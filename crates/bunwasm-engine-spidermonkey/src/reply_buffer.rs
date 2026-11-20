use std::ffi::c_char;

pub fn into_raw(text: String) -> (*mut c_char, usize) {
    let bytes = text.into_bytes().into_boxed_slice();
    let length = bytes.len();
    (Box::into_raw(bytes).cast::<c_char>(), length)
}

/// # Safety
/// `bytes` and `length` must be the unreleased pair returned by `into_raw`.
pub unsafe fn free_raw(bytes: *mut c_char, length: usize) {
    let slice = std::ptr::slice_from_raw_parts_mut(bytes.cast::<u8>(), length);
    drop(unsafe { Box::from_raw(slice) });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_delimited_replies_preserve_all_bytes() {
        for text in [
            "",
            "ordinary.ts",
            "\\windows\\file.ts",
            "日本語/🦀.ts",
            "\0plugin-vue:export-helper",
            "/home/user/\0plugin-vue:export-helper",
            "\0a\0b\0",
            "export default '\0';",
        ] {
            let (bytes, length) = into_raw(text.to_owned());
            let reply = unsafe { std::slice::from_raw_parts(bytes.cast::<u8>(), length) };
            assert_eq!(reply, text.as_bytes());
            unsafe { free_raw(bytes, length) };
        }
    }
}
