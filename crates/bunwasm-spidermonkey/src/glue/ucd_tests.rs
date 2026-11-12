use super::*;
use icu_properties::props::ParseableEnumeratedProperty;
use std::collections::BTreeMap;
use std::ffi::CString;

extern "C" {
    fn bunsm_icu_host_controls() -> i32;
    fn bunsm_icu_host_oom();
    fn bunsm_icu_alias_value(property: i32, name: *const c_char) -> i32;
}

unsafe extern "C" fn capture(context: *mut c_void, first: u32, last: u32) {
    let output = &mut *context.cast::<Vec<u32>>();
    output.extend(first..=last);
}
fn closure(cp: u32, output: &mut Vec<u32>) {
    output.clear();
    let range = CodePointRange {
        first: cp,
        last: cp,
    };
    unsafe { bunsm_ucd_close_over_scf(&range, 1, capture, (output as *mut Vec<u32>).cast()) };
    output.sort_unstable();
    output.dedup();
}
fn inverse_groups() -> BTreeMap<u32, Vec<u32>> {
    let mut groups = BTreeMap::<u32, Vec<u32>>::new();
    for cp in 0..=0x10ffff {
        let folded = simple_fold(cp);
        if folded == cp {
            continue;
        }
        groups
            .entry(folded)
            .or_insert_with(|| vec![folded])
            .push(cp);
    }
    for group in groups.values_mut() {
        group.sort_unstable();
    }
    groups
}

#[test]
fn glue_full_domain_simple_fold_inverse() {
    let groups = inverse_groups();
    let mut actual = Vec::new();
    for cp in 0..=0x10ffff {
        closure(cp, &mut actual);
        let singleton = [cp];
        let expected = groups
            .get(&simple_fold(cp))
            .map_or(singleton.as_slice(), Vec::as_slice);
        assert_eq!(actual, expected, "simple-fold closure U+{cp:04X}");
    }
    println!(
        "C1a checked 1,114,112 code points including 2,048 surrogate code points; inverse groups built once"
    );
}

fn check_aliases<T: ParseableEnumeratedProperty>(
    property: i32,
    number: impl Fn(T) -> u32,
) -> usize {
    let mut count = 0;
    for (alias, _) in T::SINGLETON.map.iter() {
        let alias = CString::new(alias).unwrap();
        let parsed = PropertyParser::<T>::new()
            .get_strict_utf8(alias.as_bytes())
            .unwrap();
        let expected = i32::try_from(number(parsed)).unwrap();
        assert_eq!(
            unsafe { bunsm_icu_alias_value(property, alias.as_ptr()) },
            expected
        );
        count += 1;
    }
    count
}
#[test]
fn glue_exhaustive_strict_aliases() {
    let gc = check_aliases::<GeneralCategory>(GENERAL_CATEGORY as i32, |value| value as u32);
    let masks = check_aliases::<GeneralCategoryGroup>(GENERAL_CATEGORY_MASK as i32, u32::from);
    let script = check_aliases::<Script>(SCRIPT as i32, TrieValue::to_u32);
    let scx = check_aliases::<Script>(SCRIPT_EXTENSIONS as i32, TrieValue::to_u32);
    println!(
        "C1b strict values: gc {gc}, masks {masks}, sc {script}, scx {scx}; all 60 property names checked by C++"
    );
    for (property, name) in [
        (GENERAL_CATEGORY_MASK, "digit"),
        (GENERAL_CATEGORY_MASK, "punct"),
        (GENERAL_CATEGORY_MASK, "Combining_Mark"),
        (SCRIPT, "Qaac"),
    ] {
        let name = CString::new(name).unwrap();
        assert_ne!(
            unsafe { bunsm_icu_alias_value(property as i32, name.as_ptr()) },
            -1
        );
    }
}

#[path = "special_case.rs"]
mod special_case;
extern "C" {
    fn bunsm_icu_cpp_supplementary(cp: u32) -> bool;
    fn bunsm_icu_old_cpp_supplementary(cp: u32) -> bool;
    fn bunsm_icu_cpp_ignore(cp: u32) -> bool;
    fn bunsm_icu_old_cpp_ignore(cp: u32) -> bool;
}
#[test]
fn glue_generated_special_case_cpp_full_bmp() {
    let selected = special_case::compute();
    assert_eq!(selected.ignore.len(), 67);
    let mut old_mismatches = Vec::new();
    for cp in 0..0x10000 {
        let expected = selected.supplementary.contains(&cp);
        assert_eq!(
            unsafe { bunsm_icu_cpp_supplementary(cp) },
            expected,
            "selected C++ predicate U+{cp:04X}"
        );
        assert_eq!(
            unsafe { bunsm_icu_cpp_ignore(cp) },
            selected.ignore.contains(&cp),
            "selected C++ IgnoreSet U+{cp:04X}"
        );
        assert_eq!(
            unsafe { bunsm_icu_old_cpp_ignore(cp) },
            selected.ignore.contains(&cp),
            "old 67-member IgnoreSet preserved U+{cp:04X}"
        );
        if unsafe { bunsm_icu_old_cpp_supplementary(cp) } != expected {
            old_mismatches.push(cp);
        }
    }
    assert_eq!(
        old_mismatches,
        [0xdf, 0x1e9e],
        "old generated support is the failing baseline"
    );
    println!(
        "C1d complete BMP: selected actual C++ predicate and 67-member IgnoreSet match; old actual C++ predicate fails at {old_mismatches:x?}"
    );
}

#[test]
fn glue_adapter_controls() {
    assert_eq!(unsafe { bunsm_icu_host_controls() }, 5);
}

#[test]
fn glue_allocator_failure_child() {
    if std::env::var_os("BUNSM_ICU_OOM_CHILD").is_some() {
        unsafe { bunsm_icu_host_oom() };
        panic!("fatal allocator returned");
    }
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "ucd::tests::glue_allocator_failure_child",
            "--nocapture",
        ])
        .env("BUNSM_ICU_OOM_CHILD", "1")
        .output()
        .unwrap();
    assert_eq!(child.status.code(), Some(134));
    let stderr = String::from_utf8_lossy(&child.stderr);
    assert!(
        stderr.contains("AutoEnterOOMUnsafeRegion::crash: bunwasm ICU subset allocation failure")
    );
    println!(
        "C1e allocation 1 forced through production allocator.cpp; host fatal seam exited 134"
    );
}

unsafe extern "C" fn discard_string(_: *mut c_void, _: *const u16, _: usize) {}
fn copied_property(name: &str, negate: bool, folding: bool) -> Vec<u32> {
    let name = CString::new(name).unwrap();
    let mut result = Vec::<u32>::new();
    let mut sink: RangeSink = capture;
    let ok = unsafe {
        crate::properties::mozilla_properties_glue_add_property_ranges(
            (&mut result as *mut Vec<u32>).cast(),
            (&mut sink as *mut RangeSink).cast(),
            name.as_ptr(),
            negate,
            folding,
        )
    };
    assert!(ok);
    result
}
#[test]
fn glue_copied_cwcf_cwkcf_upstream_behavior() {
    for name in [
        "CWCF",
        "CWKCF",
        "Changes_When_Casefolded",
        "Changes_When_NFKC_Casefolded",
    ] {
        let c_name = CString::new(name).unwrap();
        assert!(unsafe {
            crate::properties::mozilla_properties_glue_has_property(c_name.as_ptr())
        });
        let data = CodePointSetData::new_for_ecma262(name.as_bytes()).unwrap();
        for folding in [false, true] {
            let mut builder = initial_property_builder(data);
            if folding {
                add_upstream_closure(data, &mut builder);
            }
            check_copied_complement(name, folding, builder);
        }
    }
    assert!(!unsafe {
        crate::properties::mozilla_properties_glue_has_property(c"ID_Start".as_ptr())
    });
    println!(
        "C1c upstream CWCF/CWKCF: all four aliases, positive/complement and default case closure"
    );
}
fn initial_property_builder(
    data: icu_properties::CodePointSetDataBorrowed<'_>,
) -> icu_collections::codepointinvlist::CodePointInversionListBuilder {
    let mut builder = icu_collections::codepointinvlist::CodePointInversionListBuilder::new();
    for range in data.iter_ranges() {
        builder.add_range32(range);
    }
    builder
}
fn add_upstream_closure(
    data: icu_properties::CodePointSetDataBorrowed<'_>,
    builder: &mut icu_collections::codepointinvlist::CodePointInversionListBuilder,
) {
    for range in data.iter_ranges() {
        for cp in range {
            let Some(ch) = char::from_u32(cp) else {
                continue;
            };
            CaseMapperBorrowed::new().add_case_closure_to(ch, builder);
        }
    }
}
fn check_copied_complement(
    name: &str,
    folding: bool,
    mut builder: icu_collections::codepointinvlist::CodePointInversionListBuilder,
) {
    let expected: Vec<_> = builder.clone().build().iter_ranges().flatten().collect();
    assert_eq!(copied_property(name, false, folding), expected);
    builder.complement();
    let expected: Vec<_> = builder.build().iter_ranges().flatten().collect();
    assert_eq!(copied_property(name, true, folding), expected);
}
#[test]
fn glue_valid_empty_string_only_and_unknown_values() {
    let mut ranges = Vec::<u32>::new();
    let sink = Sink {
        context: (&mut ranges as *mut Vec<u32>).cast(),
        range: capture,
        string: discard_string,
    };
    assert!(property_ranges(GENERAL_CATEGORY_MASK, b"", 0, sink));
    assert!(ranges.is_empty());
    assert!(!property_ranges(GENERAL_CATEGORY, b"", 0x100, sink));
    assert!(!property_ranges(GENERAL_CATEGORY_MASK, b"", -1, sink));
    assert!(!property_ranges(0xdead, b"", 1, sink));
    let set = EmojiSetData::new::<BasicEmoji>().static_to_owned();
    for string in set
        .to_code_point_inversion_list_string_list()
        .strings()
        .iter()
    {
        assert!(string.encode_utf16().count() <= 4);
    }
}

#[derive(Default)]
struct Collected {
    ranges: Vec<(u32, u32)>,
    strings: Vec<Vec<u32>>,
}
unsafe extern "C" fn collect_range(context: *mut c_void, first: u32, last: u32) {
    (*context.cast::<Collected>()).ranges.push((first, last));
}
unsafe extern "C" fn collect_string(context: *mut c_void, units: *const u16, length: usize) {
    let units = core::slice::from_raw_parts(units, length);
    let string = char::decode_utf16(units.iter().copied())
        .map(|ch| ch.expect("emoji strings are well formed") as u32)
        .collect();
    (*context.cast::<Collected>()).strings.push(string);
}
fn query(property: u32, value: i32) -> Option<Collected> {
    let mut collected = Collected::default();
    let context = (&mut collected as *mut Collected).cast();
    let ok = unsafe {
        bunsm_ucd_property_ranges(
            property,
            c"".as_ptr(),
            value,
            collect_range,
            collect_string,
            context,
        )
    };
    ok.then_some(collected)
}
fn merged(mut ranges: Vec<(u32, u32)>) -> Vec<(u32, u32)> {
    ranges.sort_unstable();
    let mut result: Vec<(u32, u32)> = Vec::new();
    for (first, last) in ranges {
        match result.last_mut() {
            Some(previous) if previous.1 + 1 >= first => previous.1 = previous.1.max(last),
            _ => result.push((first, last)),
        }
    }
    result
}
/// Mirrors `checksum` in spidermonkey/emoji-sequences.ts.
fn checksum(strings: &[Vec<u32>]) -> u64 {
    let mut sorted = strings.to_vec();
    sorted.sort_unstable();
    let step = |state: u64, value: u32| (state ^ u64::from(value)).wrapping_mul(0x100000001b3);
    sorted.iter().fold(0xcbf29ce484222325, |state, string| {
        step(
            string.iter().fold(state, |state, &cp| step(state, cp)),
            0xffff_ffff,
        )
    })
}
fn assert_distinct(strings: &[Vec<u32>], name: &str) {
    let mut sorted = strings.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), strings.len(), "{name} strings are distinct");
}

#[test]
fn glue_u2_sequence_properties_match_generated_inputs() {
    let mut total = 0;
    for (property, (count, expected)) in emoji::SEQUENCES.zip(emoji::data::EXPECTED) {
        let collected = query(property, 1).expect("valid string property");
        assert!(
            collected.ranges.is_empty(),
            "property {property} has no code points"
        );
        assert_eq!(collected.strings.len(), count, "property {property} count");
        assert_eq!(
            checksum(&collected.strings),
            expected,
            "property {property} input checksum"
        );
        assert!(collected.strings.iter().all(|string| string.len() >= 2));
        assert_distinct(&collected.strings, "sequence");
        assert!(
            query(property, 0).is_none(),
            "property {property} has no N value"
        );
        assert!(
            query(property, 2).is_none(),
            "property {property} rejects other values"
        );
        total += count;
    }
    println!(
        "U2 five sequence properties: {total} strings match the Unicode emoji 18.0 input lists"
    );
}

#[test]
fn glue_u2_basic_emoji_matches_emoji_input_version() {
    let collected = query(65, 1).expect("Basic_Emoji");
    let expected = merged(emoji::data::BASIC_EMOJI_RANGES.to_vec());
    assert_eq!(
        merged(collected.ranges),
        expected,
        "ICU4X Basic_Emoji code points"
    );
    let mut actual = collected.strings;
    let mut strings: Vec<Vec<u32>> = emoji::data::BASIC_EMOJI_STRINGS
        .iter()
        .map(|s| s.to_vec())
        .collect();
    actual.sort_unstable();
    strings.sort_unstable();
    assert_eq!(actual, strings, "ICU4X Basic_Emoji strings");
    println!(
        "U2 ICU4X 2.4.0 Basic_Emoji equals emoji 18.0 input: {} ranges, {} strings",
        expected.len(),
        strings.len()
    );
}

#[test]
fn glue_u2_rgi_emoji_is_the_union() {
    let rgi = query(71, 1).expect("RGI_Emoji");
    let basic = query(65, 1).expect("Basic_Emoji");
    assert_eq!(merged(rgi.ranges), merged(basic.ranges));
    let mut expected = basic.strings;
    for property in emoji::SEQUENCES {
        expected.extend(query(property, 1).expect("sequence property").strings);
    }
    assert_distinct(&rgi.strings, "RGI_Emoji");
    let mut actual = rgi.strings;
    actual.sort_unstable();
    expected.sort_unstable();
    assert_eq!(actual, expected);
    assert!(query(71, 0).is_none());
    println!(
        "U2 RGI_Emoji: Basic_Emoji code points plus {} distinct strings",
        actual.len()
    );
}

extern "C" {
    fn bunsm_icu_host_lookup(
        name: *const c_char,
        value: *const c_char,
        negate: bool,
        sink: RangeSink,
        context: *mut c_void,
    ) -> bool;
}
unsafe extern "C" fn capture_range(context: *mut c_void, first: u32, last: u32) {
    (*context.cast::<Vec<(u32, u32)>>()).push((first, last));
}
fn format_ranges(ranges: &[(u32, u32)]) -> String {
    let items: Vec<String> = ranges.iter().map(|(a, b)| format!("{a:x}-{b:x}")).collect();
    items.join(",")
}
fn lookup_line(line: &str) -> String {
    let mut fields = line.split('\t');
    let (name, value, negate) = (
        fields.next().unwrap(),
        fields.next().unwrap(),
        fields.next() == Some("1"),
    );
    let (name, value) = (CString::new(name).unwrap(), CString::new(value).unwrap());
    let mut ranges = Vec::<(u32, u32)>::new();
    let context = (&mut ranges as *mut Vec<(u32, u32)>).cast();
    let ok = unsafe {
        bunsm_icu_host_lookup(
            name.as_ptr(),
            value.as_ptr(),
            negate,
            capture_range,
            context,
        )
    };
    if !ok {
        return format!("{line}\tFAIL");
    }
    format!("{line}\tOK\t{}", format_ranges(&merged(ranges)))
}

/// Evidence harness, not CI: the input lists pinned test262 property escapes.
/// Each line is `name<TAB>value<TAB>negate`; the output adds the adapter's set.
#[test]
#[ignore = "needs BUNWASM_PROPERTY_LOOKUPS and BUNWASM_PROPERTY_RESULTS"]
fn glue_irregexp_lookup_dump() {
    let input = std::env::var("BUNWASM_PROPERTY_LOOKUPS").unwrap();
    let output = std::env::var("BUNWASM_PROPERTY_RESULTS").unwrap();
    let text = std::fs::read_to_string(input).unwrap();
    let lines: Vec<String> = text.lines().map(lookup_line).collect();
    std::fs::write(output, lines.join("\n") + "\n").unwrap();
    println!("irregexp u-mode lookups dumped: {}", lines.len());
}

/// The context scan of `Final_Sigma` in js/src/builtin/String.cpp at the
/// Mozilla pin, over code points, calling the two exported predicates.
fn cased_context<'a>(mut context: impl Iterator<Item = &'a u32>) -> bool {
    context
        .find(|&&cp| !bunsm_ucd_is_case_ignorable(cp))
        .is_some_and(|&cp| bunsm_ucd_is_cased(cp))
}
fn final_sigma(chars: &[u32], index: usize) -> u32 {
    let preceded = cased_context(chars[..index].iter().rev());
    let followed = cased_context(chars[index + 1..].iter());
    if preceded && !followed { 0x3c2 } else { 0x3c3 }
}
fn lower(text: &str) -> String {
    let chars: Vec<u32> = text.chars().map(u32::from).collect();
    let mapped = chars.iter().enumerate().map(|(index, &cp)| match cp {
        0x3a3 => final_sigma(&chars, index),
        _ => char::from_u32(cp)
            .unwrap()
            .to_lowercase()
            .next()
            .map_or(cp, u32::from),
    });
    mapped.map(|cp| char::from_u32(cp).unwrap()).collect()
}

#[test]
fn glue_u3_final_sigma_predicates() {
    let cased = CodePointSetData::new_for_ecma262(b"Cased").unwrap();
    let ignorable = CodePointSetData::new_for_ecma262(b"Case_Ignorable").unwrap();
    for cp in 0..=0x10ffff {
        assert_eq!(
            bunsm_ucd_is_cased(cp),
            cased.contains32(cp),
            "Cased U+{cp:04X}"
        );
        assert_eq!(
            bunsm_ucd_is_case_ignorable(cp),
            ignorable.contains32(cp),
            "CI U+{cp:04X}"
        );
    }
    // test262 special_casing_conditional.js and Final_Sigma_U180E.js at the pin.
    for (input, expected) in [
        ("\u{3a3}", "\u{3c3}"),
        ("A\u{3a3}", "a\u{3c2}"),
        ("\u{1d4a2}\u{3a3}", "\u{1d4a2}\u{3c2}"),
        ("A.\u{3a3}", "a.\u{3c2}"),
        ("A\u{ad}\u{3a3}", "a\u{ad}\u{3c2}"),
        ("A\u{180e}\u{3a3}\u{180e}", "a\u{180e}\u{3c2}\u{180e}"),
        ("A\u{180e}\u{3a3}\u{180e}B", "a\u{180e}\u{3c3}\u{180e}b"),
        ("A\u{180e}\u{3a3}", "a\u{180e}\u{3c2}"),
        ("A\u{180e}\u{3a3}B", "a\u{180e}\u{3c3}b"),
        ("A\u{3a3}\u{180e}", "a\u{3c2}\u{180e}"),
        ("A\u{3a3}\u{180e}B", "a\u{3c3}\u{180e}b"),
        (
            "\u{39f}\u{394}\u{39f}\u{3a3}",
            "\u{3bf}\u{3b4}\u{3bf}\u{3c2}",
        ),
    ] {
        assert_eq!(lower(input), expected, "{input:?}");
    }
    println!(
        "U3 Cased and Case_Ignorable exports match ICU4X over all code points; Final_Sigma test262 cases pass"
    );
}
