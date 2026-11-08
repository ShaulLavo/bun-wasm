/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use core::ffi::CStr;
use core::ffi::c_char;
use core::ffi::c_void;
use icu_collections::codepointinvlist::CodePointInversionListBuilder;

extern "C" {
    fn js_irregexp_add_range_to_zone_list(
        list: *mut c_void,
        zone: *mut c_void,
        start: u32,
        inclusive_end: u32,
    );
}

// For now, let's use ICU4X to handle only what we no longer
// have ICU4C support for.
fn lookup_property_set(name: &[u8]) -> Option<icu_properties::CodePointSetDataBorrowed<'static>> {
    match name {
        b"Changes_When_NFKC_Casefolded" | b"CWKCF" | b"Changes_When_Casefolded" | b"CWCF" => {}
        _ => {
            return None;
        }
    }
    icu_properties::CodePointSetData::new_for_ecma262(name)
}

/// # Safety
/// `name` is a live NUL-terminated property name.
#[no_mangle]
pub unsafe extern "C" fn mozilla_properties_glue_has_property(name: *const c_char) -> bool {
    lookup_property_set(CStr::from_ptr(name).to_bytes()).is_some()
}

fn add_range_closure(
    range: core::ops::RangeInclusive<u32>,
    builder: &mut CodePointInversionListBuilder,
) {
    let mapper = icu_casemap::CaseMapperBorrowed::new();
    for cp in range {
        if let Some(ch) = char::from_u32(cp) {
            mapper.add_case_closure_to(ch, builder);
        }
    }
}

fn folded_property(
    prop: icu_properties::CodePointSetDataBorrowed<'_>,
    negate: bool,
) -> icu_collections::codepointinvlist::CodePointInversionList<'static> {
    let mut builder = CodePointInversionListBuilder::new();
    for range in prop.iter_ranges() {
        builder.add_range32(range.clone());
        add_range_closure(range, &mut builder);
    }
    if negate {
        builder.complement();
    }
    builder.build()
}

/// # Safety
/// The name is NUL terminated and the native zone callback consumes each range
/// synchronously. `list` and `zone` have the upstream callback's types.
#[no_mangle]
pub unsafe extern "C" fn mozilla_properties_glue_add_property_ranges(
    list: *mut c_void,
    zone: *mut c_void,
    name: *const c_char,
    negate: bool,
    needs_case_folding: bool,
) -> bool {
    let Some(prop) = lookup_property_set(CStr::from_ptr(name).to_bytes()) else {
        return false;
    };
    if needs_case_folding {
        for range in folded_property(prop, negate).iter_ranges() {
            js_irregexp_add_range_to_zone_list(list, zone, *range.start(), *range.end());
        }
        return true;
    }
    if negate {
        for range in prop.iter_ranges_complemented() {
            js_irregexp_add_range_to_zone_list(list, zone, *range.start(), *range.end());
        }
        return true;
    }
    for range in prop.iter_ranges() {
        js_irregexp_add_range_to_zone_list(list, zone, *range.start(), *range.end());
    }
    true
}
