//! ICU4X data queries for the irregexp-only ICU-shaped adapter, not native Intl.
use core::ffi::{CStr, c_char, c_void};
use core::ops::RangeInclusive;
use icu_casemap::{CaseMapperBorrowed, ClosureSink};
use icu_collections::codepointtrie::TrieValue;
use icu_properties::props::{
    BasicEmoji, CaseIgnorable, Cased, GeneralCategory, GeneralCategoryGroup, Script,
};
use icu_properties::script::ScriptWithExtensions;
use icu_properties::{CodePointMapData, CodePointSetData, EmojiSetData, PropertyParser};

const GENERAL_CATEGORY: u32 = 0x1005;
const SCRIPT: u32 = 0x100a;
const GENERAL_CATEGORY_MASK: u32 = 0x2000;
const SCRIPT_EXTENSIONS: u32 = 0x7000;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CodePointRange {
    pub first: u32,
    pub last: u32,
}

pub type RangeSink = unsafe extern "C" fn(*mut c_void, u32, u32);
pub type StringSink = unsafe extern "C" fn(*mut c_void, *const u16, usize);

#[derive(Clone, Copy)]
struct Sink {
    context: *mut c_void,
    range: RangeSink,
    string: StringSink,
}
impl Sink {
    fn ranges(self, ranges: impl Iterator<Item = RangeInclusive<u32>>) {
        for range in ranges {
            unsafe { (self.range)(self.context, *range.start(), *range.end()) };
        }
    }
    fn utf16(self, units: &[u16]) {
        unsafe { (self.string)(self.context, units.as_ptr(), units.len()) };
    }
}

#[path = "emoji.rs"]
mod emoji;

fn simple_fold(cp: u32) -> u32 {
    char::from_u32(cp).map_or(cp, |ch| CaseMapperBorrowed::new().simple_fold(ch) as u32)
}

struct SimpleClosureSink {
    fold: u32,
    callback: RangeSink,
    context: *mut c_void,
}
impl ClosureSink for SimpleClosureSink {
    fn add_char(&mut self, ch: char) {
        if simple_fold(ch as u32) != self.fold {
            return;
        }
        unsafe { (self.callback)(self.context, ch as u32, ch as u32) };
    }
    fn add_string(&mut self, _: &str) {}
}

fn close_code_point(cp: u32, callback: RangeSink, context: *mut c_void) {
    let fold = simple_fold(cp);
    let Some(ch) = char::from_u32(fold) else {
        return;
    };
    let mut sink = SimpleClosureSink {
        fold,
        callback,
        context,
    };
    sink.add_char(ch);
    // The pinned 2.4.0 implementation does not recurse. String callbacks are
    // ignored, never expanded into characters. C1 checks the complete inverse.
    CaseMapperBorrowed::new().add_case_closure_to(ch, &mut sink);
}

/// # Safety
/// `ranges` contains `count` valid domain ranges. `callback` accepts each range
/// synchronously and does not retain pointers into Rust.
#[no_mangle]
pub unsafe extern "C" fn bunsm_ucd_close_over_scf(
    ranges: *const CodePointRange,
    count: usize,
    callback: RangeSink,
    context: *mut c_void,
) {
    if count == 0 {
        return;
    }
    for range in core::slice::from_raw_parts(ranges, count) {
        callback(context, range.first, range.last);
        for cp in range.first..=range.last {
            close_code_point(cp, callback, context);
        }
    }
}

#[no_mangle]
pub extern "C" fn bunsm_ucd_simple_fold(cp: u32) -> u32 {
    simple_fold(cp)
}

#[no_mangle]
pub extern "C" fn bunsm_ucd_is_letter(cp: u32) -> bool {
    GeneralCategoryGroup::Letter.contains(CodePointMapData::<GeneralCategory>::new().get32(cp))
}

// U3: String.prototype.toLowerCase decides Final_Sigma with these, through the
// WASI patch's String.cpp arm, as Intl builds do with ICU4C.
#[no_mangle]
pub extern "C" fn bunsm_ucd_is_cased(cp: u32) -> bool {
    CodePointSetData::new::<Cased>().contains32(cp)
}

#[no_mangle]
pub extern "C" fn bunsm_ucd_is_case_ignorable(cp: u32) -> bool {
    CodePointSetData::new::<CaseIgnorable>().contains32(cp)
}

fn value_enum(property: u32, name: &[u8]) -> Option<i32> {
    match property {
        GENERAL_CATEGORY => PropertyParser::<GeneralCategory>::new()
            .get_strict_utf8(name)
            .map(|value| value as i32),
        GENERAL_CATEGORY_MASK => PropertyParser::<GeneralCategoryGroup>::new()
            .get_strict_utf8(name)
            .map(|value| u32::from(value) as i32),
        SCRIPT | SCRIPT_EXTENSIONS => PropertyParser::<Script>::new()
            .get_strict_u16_utf8(name)
            .map(i32::from),
        0..=71 => match name {
            b"Y" => Some(1),
            b"N" => Some(0),
            _ => None,
        },
        _ => None,
    }
}

/// # Safety
/// `name` is NUL terminated and `out` is writable for this call.
#[no_mangle]
pub unsafe extern "C" fn bunsm_ucd_value_enum(
    property: u32,
    name: *const c_char,
    out: *mut i32,
) -> bool {
    if name.is_null() || out.is_null() {
        return false;
    }
    let Some(value) = value_enum(property, CStr::from_ptr(name).to_bytes()) else {
        return false;
    };
    *out = value;
    true
}

fn binary_ranges(name: &[u8], value: i32, sink: Sink) -> bool {
    if value != 0 && value != 1 {
        return false;
    }
    let Some(data) = CodePointSetData::new_for_ecma262(name) else {
        return false;
    };
    if value == 0 {
        sink.ranges(data.iter_ranges_complemented());
    } else {
        sink.ranges(data.iter_ranges());
    }
    true
}

fn basic_emoji(value: i32, sink: Sink) -> bool {
    if value != 1 {
        return false;
    }
    let set = EmojiSetData::new::<BasicEmoji>().static_to_owned();
    let data = set.to_code_point_inversion_list_string_list();
    sink.ranges(data.code_points().iter_ranges());
    for string in data.strings().iter() {
        emoji::string(sink, string);
    }
    true
}

fn rgi_emoji(value: i32, sink: Sink) -> bool {
    if !basic_emoji(value, sink) {
        return false;
    }
    for property in emoji::SEQUENCES {
        emoji::sequences(property, sink);
    }
    true
}

fn script_ranges(property: u32, value: i32, sink: Sink) -> bool {
    let Ok(number) = u16::try_from(value) else {
        return false;
    };
    let Ok(script) = Script::try_from_u32(u32::from(number)) else {
        return false;
    };
    // Reject unrecognized integers, but retain named scripts with no members.
    if icu_properties::PropertyNamesLong::<Script>::new()
        .get(script)
        .is_none()
    {
        return false;
    }
    if property == SCRIPT {
        sink.ranges(CodePointMapData::<Script>::new().iter_ranges_for_value(script));
    } else {
        sink.ranges(ScriptWithExtensions::new().get_script_extensions_ranges(script));
    }
    true
}

fn general_category(value: i32, sink: Sink) -> bool {
    let Ok(number) = u8::try_from(value) else {
        return false;
    };
    let Ok(category) = GeneralCategory::try_from(number) else {
        return false;
    };
    sink.ranges(CodePointMapData::<GeneralCategory>::new().iter_ranges_for_value(category));
    true
}
fn category_mask(value: i32, sink: Sink) -> bool {
    if value < 0 || value as u32 & !0x3fff_ffff != 0 {
        return false;
    }
    sink.ranges(
        CodePointMapData::<GeneralCategory>::new()
            .iter_ranges_for_group(GeneralCategoryGroup::from(value as u32)),
    );
    true
}
fn property_ranges(property: u32, name: &[u8], value: i32, sink: Sink) -> bool {
    match property {
        GENERAL_CATEGORY => general_category(value, sink),
        GENERAL_CATEGORY_MASK => category_mask(value, sink),
        SCRIPT | SCRIPT_EXTENSIONS => script_ranges(property, value, sink),
        65 => basic_emoji(value, sink),
        // Properties of strings have no "N" value; negation is an early error.
        66..=70 => value == 1 && emoji::sequences(property, sink),
        71 => rgi_emoji(value, sink),
        0..=64 => binary_ranges(name, value, sink),
        _ => false,
    }
}

/// # Safety
/// `name` is NUL terminated. Callbacks consume ranges or temporary UTF-16 units
/// synchronously. Validity is independent of the number of callback invocations.
#[no_mangle]
pub unsafe extern "C" fn bunsm_ucd_property_ranges(
    property: u32,
    name: *const c_char,
    value: i32,
    range: RangeSink,
    string: StringSink,
    context: *mut c_void,
) -> bool {
    if name.is_null() {
        return false;
    }
    property_ranges(
        property,
        CStr::from_ptr(name).to_bytes(),
        value,
        Sink {
            context,
            range,
            string,
        },
    )
}

#[cfg(all(test, feature = "unicode-controls"))]
#[path = "ucd_tests.rs"]
mod tests;
