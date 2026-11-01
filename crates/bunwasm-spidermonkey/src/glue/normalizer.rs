/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use core::ffi::c_void;
use smallvec::SmallVec;

// The same as js::intl::INITIAL_CHAR_BUFFER_SIZE
const INLINE_SIZE: usize = 32;

type Buffer = SmallVec<[u16; INLINE_SIZE]>;

#[expect(dead_code, reason = "C++ supplies all four C ABI discriminants")]
#[derive(Debug, PartialEq, Clone, Copy)]
#[repr(C)]
pub enum NormalizationForm {
    Nfc = 0,
    Nfkc = 1,
    Nfd = 2,
    Nfkd = 3,
}

#[repr(transparent)]
pub struct JSContext {
    _inner: c_void,
}

#[repr(transparent)]
pub struct JSLinearString {
    _inner: c_void,
}

extern "C" {
    fn js_call_js_normalize_utf16(
        cx: *mut JSContext,
        form: NormalizationForm,
        in_string: *mut JSLinearString,
        buffer: *mut c_void,
    ) -> bool;

    fn js_call_js_normalize_latin1(
        cx: *mut JSContext,
        form: NormalizationForm,
        in_string: *mut JSLinearString,
        buffer: *mut c_void,
    ) -> bool;

    fn js_new_ucstring_copy_n(
        cx: *mut JSContext,
        ptr: *const u16,
        len: usize,
    ) -> *mut JSLinearString;

    fn js_new_ucstring_copy_n_dont_deflate(
        cx: *mut JSContext,
        ptr: *const u16,
        len: usize,
    ) -> *mut JSLinearString;
}

#[no_mangle]
pub unsafe extern "C" fn js_normalize(
    cx: *mut JSContext,
    form: NormalizationForm,
    in_string: *mut JSLinearString,
    latin1: bool,
) -> *mut JSLinearString {
    // The purpose of this function is to establish `buffer` as a Rust type
    // on the stack. We need to call through a layer of C++ to the actual
    // normalization code so that we can use `AutoCheckCannotGC` as C++ RAII
    // that goes out of scope before we (potentially) create a new string
    // later in this function.

    // An earlier attempt used a `JSStringBuilder` as the buffer, but the
    // cases where a `JSString` ends up reusing the buffer within
    // `JSStringBuilder` are so slim, that it's better not to go ever FFI
    // for every write to the buffer and instead do a bulk copy out of
    // the buffer at the end of this function.
    let mut buffer: Buffer = SmallVec::new();
    let buffer_ptr: *mut Buffer = &mut buffer;
    let void_ptr = buffer_ptr.cast::<c_void>();
    let ok = if latin1 {
        js_call_js_normalize_latin1(cx, form, in_string, void_ptr)
    } else {
        js_call_js_normalize_utf16(cx, form, in_string, void_ptr)
    };
    if !ok {
        return std::ptr::null_mut();
    }

    // If nothing wrote to the buffer (and we haven't already returned), it's a
    // signal that the input is its own normalization.
    if buffer.is_empty() {
        return in_string;
    }

    // If we are normalizing to Nfd and the input isn't its own normalization,
    // we know the output cannot be Latin1-only.
    if form == NormalizationForm::Nfd {
        return js_new_ucstring_copy_n_dont_deflate(cx, buffer.as_ptr(), buffer.len());
    }

    js_new_ucstring_copy_n(cx, buffer.as_ptr(), buffer.len())
}

macro_rules! normalization_entry {
    ($name:ident, $unit:ty, $normalize:ident) => {
        #[no_mangle]
        pub unsafe extern "C" fn $name(
            form: NormalizationForm,
            ptr: *const $unit,
            len: usize,
            buffer: *mut c_void,
        ) -> bool {
            $normalize(
                form,
                core::slice::from_raw_parts(ptr, len),
                &mut *buffer.cast::<Buffer>(),
            )
        }
    };
}
normalization_entry!(js_normalize_utf16, u16, normalize_utf16);
normalization_entry!(js_normalize_latin1, u8, normalize_latin1);

fn maybe_reserve_buffer_space(
    form: NormalizationForm,
    input_len: usize,
    tail_len: usize,
    buffer: &mut Buffer,
) -> bool {
    if input_len <= INLINE_SIZE {
        // Let's not preallocate on the heap.
        return true;
    }
    // We're going to end up allocating on the heap. Since the allocation
    // is short-lived, let's overallocate in order to reduce the probability
    // of allocating multiple times during normalization. These are just
    // guesses.

    // Note that the normalizer itself calls the infallible `reserve`
    // with `input_len` as the argument, so it will always do nothing,
    // since we do greater than or equal to that with `try_reserve`
    // below.
    match form {
        NormalizationForm::Nfc => {
            // Output typically shorter than input.
            buffer.try_reserve(input_len).is_ok()
        }
        NormalizationForm::Nfkc => {
            // Output may expand a bit.
            let extra = core::cmp::max(8, tail_len / 16);
            buffer.try_reserve(input_len + extra).is_ok()
        }
        NormalizationForm::Nfd | NormalizationForm::Nfkd => {
            // Output may expand some more.
            // `tail_len / 8` is good for Greek
            // `tail_len / 4 + tail_len / 32` is good for Vietnamese
            // `tail_len` is good for Korean
            // Let's pick an arbitrary threshold for sizing for no
            // reallocation for Korean vs. no reallocation for Greek.
            let extra = core::cmp::max(16, expansion_tail(tail_len));
            buffer.try_reserve(input_len + extra).is_ok()
        }
    }
}

fn expansion_tail(tail_len: usize) -> usize {
    if tail_len <= 1024 {
        return tail_len;
    }
    tail_len / 8
}

fn normalize_utf16(form: NormalizationForm, input: &[u16], buffer: &mut Buffer) -> bool {
    match form {
        NormalizationForm::Nfc | NormalizationForm::Nfkc => {
            normalize_composing(form, input, buffer)
        }
        NormalizationForm::Nfd | NormalizationForm::Nfkd => {
            normalize_decomposing(form, input, buffer)
        }
    }
}

fn normalize_composing(form: NormalizationForm, input: &[u16], buffer: &mut Buffer) -> bool {
    let normalizer = if form == NormalizationForm::Nfc {
        icu_normalizer::ComposingNormalizerBorrowed::new_nfc()
    } else {
        icu_normalizer::ComposingNormalizerBorrowed::new_nfkc()
    };
    let (head, tail) = normalizer.split_normalized_utf16(input);
    if tail.is_empty() {
        return true;
    }
    if !maybe_reserve_buffer_space(form, input.len(), tail.len(), buffer) {
        return false;
    }
    buffer.extend_from_slice(head);
    normalizer.normalize_utf16_to(tail, buffer).is_ok()
}

fn normalize_decomposing(form: NormalizationForm, input: &[u16], buffer: &mut Buffer) -> bool {
    let normalizer = if form == NormalizationForm::Nfd {
        icu_normalizer::DecomposingNormalizerBorrowed::new_nfd()
    } else {
        icu_normalizer::DecomposingNormalizerBorrowed::new_nfkd()
    };
    let (head, tail) = normalizer.split_normalized_utf16(input);
    if tail.is_empty() {
        return true;
    }
    if !maybe_reserve_buffer_space(form, input.len(), tail.len(), buffer) {
        return false;
    }
    buffer.extend_from_slice(head);
    normalizer.normalize_utf16_to(tail, buffer).is_ok()
}

fn normalize_latin1(form: NormalizationForm, input: &[u8], buffer: &mut Buffer) -> bool {
    let mut utf16 = Buffer::new();
    if utf16.try_reserve_exact(input.len()).is_err() {
        return false;
    }
    utf16.extend(input.iter().map(|byte| u16::from(*byte)));
    normalize_utf16(form, &utf16, buffer)
}

// The items below are not used by SpiderMonkey but are offered through headers that
// are supposed to work in SpiderMonkey.

#[no_mangle]
pub unsafe extern "C" fn mozilla_canonical_composition(a: u32, b: u32) -> u32 {
    icu_normalizer::properties::CanonicalCompositionBorrowed::new()
        .compose(
            char::from_u32(a).unwrap_or('\u{0}'),
            char::from_u32(b).unwrap_or('\u{0}'),
        )
        .unwrap_or('\u{0}')
        .into()
}

#[no_mangle]
pub unsafe extern "C" fn mozilla_canonical_combining_class(c: u32) -> u8 {
    icu_normalizer::properties::CanonicalCombiningClassMapBorrowed::new().get32_u8(c)
}
