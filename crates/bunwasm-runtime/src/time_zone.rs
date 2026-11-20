//! `process.env.TZ` for an engine without zones of its own (QuickJS): one zone's transitions,
//! read from the FormatJS zone data the runtime already embeds (`src/js/tz_data.js`). The guest
//! never parses that 1.36 MB module for `TZ`; `time_zone.ts` turns the one zone it asks for into
//! the engine's offset table. The fallback `Intl` still loads the whole module.

use crate::data::{NativeResult, Val};
use crate::natives::Table;

pub fn install(table: &mut Table) {
    table.add("timeZoneEntries", |args| {
        let name = args.str(0)?;
        let found = source().and_then(|text| entries(text, name));
        Ok(found.map_or(Val::Undefined, |(zone, entries)| {
            let entries = entries.map_or(Val::Undefined, |entries| Val::Str(entries.into()));
            Val::Array(vec![Val::Str(zone), entries])
        }))
    });
    table.add("timeZoneOffsets", |_| offsets_value());
}

fn offsets_value() -> NativeResult {
    let offsets = source().and_then(|text| string_after(sections(text)?.0, "offsets:\""));
    Ok(offsets.map_or(Val::Undefined, |offsets| Val::Str(offsets.into())))
}

fn source() -> Option<&'static str> {
    crate::modules::polyfill_source("tz_data")
}

/// The data's three parts: everything before the zone list (abbreviations and offsets), the
/// zone list, and the link table.
fn sections(text: &str) -> Option<(&str, &str, &str)> {
    let zones = text.find("zones:[")?;
    let links = text.find("data.links = {")?;
    let end = zones + text[zones..links].rfind(']')?;
    Some((&text[..zones], &text[zones..end], &text[links..]))
}

/// The quoted string that starts right after `key` in `text`.
fn string_after<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let start = text.find(key)? + key.len();
    let end = text[start..].find('"')?;
    Some(&text[start..start + end])
}

/// Only an IANA-style name can be looked up, so a name never matches across entries.
fn is_zone_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b))
}

/// The zone a name stands for and that zone's `time,abbreviation,offset,dst` entries: its own
/// when the data has them (ICU keeps Asia/Kuala_Lumpur's history although FormatJS links it to
/// Singapore), else FormatJS's link. A link whose zone has no entries (the UTC names and
/// Africa/Abidjan's group) answers with that zone and no entries; `time_zone.ts` decides.
fn entries<'a>(text: &'a str, name: &str) -> Option<(String, Option<&'a str>)> {
    if !is_zone_name(name) {
        return None;
    }
    let (_, zones, links) = sections(text)?;
    if let Some(own) = string_after(zones, &format!("\"{name}|")) {
        return Some((name.to_owned(), Some(own)));
    }
    let link = [
        format!("\"{name}\":\""),
        format!("{{{name}:\""),
        format!(",{name}:\""),
    ]
    .iter()
    .find_map(|key| string_after(links, key))?;
    Some((link.to_owned(), string_after(zones, &format!("\"{link}|"))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(name: &str) -> Option<(String, Option<&'static str>)> {
        entries(source().expect("tz_data.js is embedded"), name)
    }

    fn zone(name: &str) -> Option<String> {
        found(name).map(|found| found.0)
    }

    #[test]
    fn zones_and_links_in_the_embedded_data() {
        assert!(found("America/New_York").is_some_and(|found| found.1.is_some()));
        assert_eq!(zone("US/Eastern"), Some("America/New_York".to_owned()));
        assert_eq!(zone("Asia/Calcutta"), Some("Asia/Kolkata".to_owned()));
        // A zone with entries of its own keeps them although FormatJS links it elsewhere.
        assert!(
            found("Asia/Kuala_Lumpur")
                .is_some_and(|found| found.0 == "Asia/Kuala_Lumpur" && found.1.is_some())
        );
        let offsets = offsets_value().expect("offsets");
        assert!(matches!(offsets, Val::Str(text) if text.contains('|')));
    }

    #[test]
    fn links_to_zones_without_entries() {
        // The data has no Etc/UTC, Etc/GMT or Africa/Abidjan entries, only links to them.
        for (name, target) in [
            ("UTC", "Etc/UTC"),
            ("Zulu", "Etc/UTC"),
            ("Etc/Universal", "Etc/UTC"),
            ("GMT0", "Etc/GMT"),
            ("Greenwich", "Etc/GMT"),
            ("Iceland", "Africa/Abidjan"),
            ("Africa/Timbuktu", "Africa/Abidjan"),
        ] {
            assert_eq!(found(name), Some((target.to_owned(), None)), "{name}");
        }
    }

    #[test]
    fn names_outside_the_data_are_unknown() {
        // An abbreviation, a prefix or a suffix of a zone, a different case, and names that
        // could reach across entries.
        for name in [
            "LMT",
            "America/New",
            "New_York",
            "america/new_york",
            "",
            "a\"b",
            "x|y",
            "-5:00",
        ] {
            assert_eq!(found(name), None, "{name}");
        }
    }
}
