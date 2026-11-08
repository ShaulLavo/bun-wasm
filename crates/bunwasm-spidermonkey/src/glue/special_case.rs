//! Host-only translation of pinned PrintSpecial, using the selected ICU4X data.
use icu_casemap::CaseMapperBorrowed;
use std::collections::{BTreeMap, BTreeSet};

pub struct SpecialCaseSets {
    pub ignore: BTreeSet<u32>,
    pub supplementary: BTreeSet<u32>,
}

fn fold(cp: u32) -> u32 {
    char::from_u32(cp).map_or(cp, |ch| CaseMapperBorrowed::new().simple_fold(ch) as u32)
}
fn inverse_groups() -> BTreeMap<u32, Vec<u32>> {
    let mut groups = BTreeMap::<u32, Vec<u32>>::new();
    for cp in 0..=0x10ffff {
        let key = fold(cp);
        if key == cp {
            continue;
        }
        groups.entry(key).or_insert_with(|| vec![key]).push(cp);
    }
    groups
}
fn group<'a>(groups: &'a BTreeMap<u32, Vec<u32>>, cp: u32, singleton: &'a [u32; 1]) -> &'a [u32] {
    groups.get(&fold(cp)).map_or(singleton, Vec::as_slice)
}
fn canonicalize(cp: u32) -> u32 {
    let ch = char::from_u32(cp).expect("PrintSpecial excludes surrogates");
    let mut buffer = [0u8; 4];
    let mapped = CaseMapperBorrowed::new()
        .uppercase_to_string(ch.encode_utf8(&mut buffer), &"und".parse().unwrap());
    let mut units = mapped.encode_utf16();
    let first = units.next().expect("uppercase is nonempty");
    if units.next().is_some() || cp >= 128 && first < 128 {
        return cp;
    }
    u32::from(first)
}
fn classify(cp: u32, members: &[u32]) -> (bool, bool) {
    let key = canonicalize(cp);
    let mut matching = false;
    let mut different = false;
    for &other in members {
        if other == cp || other > 0xffff {
            continue;
        }
        if canonicalize(other) == key {
            matching = true;
        } else {
            different = true;
        }
    }
    (matching, different)
}
fn verify_special_class(cp: u32, members: &[u32], ignore: &BTreeSet<u32>) {
    let expected = canonicalize(cp);
    for &other in members {
        if other > 0xffff || ignore.contains(&other) {
            continue;
        }
        assert_eq!(
            canonicalize(other),
            expected,
            "PrintSpecial nontrivial class invariant"
        );
    }
}

pub fn compute() -> SpecialCaseSets {
    let groups = inverse_groups();
    let mut ignore = BTreeSet::new();
    let mut supplementary = BTreeSet::new();
    let mut special_add = BTreeSet::new();
    for cp in 0..0x10000 {
        if (0xd800..=0xdfff).contains(&cp) {
            continue;
        }
        let singleton = [cp];
        let members = group(&groups, cp, &singleton);
        if members.iter().any(|&member| member > 0xffff) {
            supplementary.insert(cp);
        }
        let (matching, different) = classify(cp, members);
        if !different {
            continue;
        }
        if matching {
            special_add.insert(cp);
        } else {
            ignore.insert(cp);
        }
    }
    for cp in special_add {
        verify_special_class(cp, group(&groups, cp, &[cp]), &ignore);
    }
    SpecialCaseSets {
        ignore,
        supplementary,
    }
}
