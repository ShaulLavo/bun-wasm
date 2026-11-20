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
            Val::Array(vec![Val::Str(zone), Val::Str(entries.into())])
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

/// The zone a name stands for (FormatJS's link if it is one) and that zone's
/// `time,abbreviation,offset,dst` entries.
fn entries<'a>(text: &'a str, name: &str) -> Option<(String, &'a str)> {
    if !is_zone_name(name) {
        return None;
    }
    let (_, zones, links) = sections(text)?;
    let zone = [
        format!("\"{name}\":\""),
        format!("{{{name}:\""),
        format!(",{name}:\""),
    ]
    .iter()
    .find_map(|key| string_after(links, key))
    .unwrap_or(name);
    let entries = string_after(zones, &format!("\"{zone}|"))?;
    Some((zone.to_owned(), entries))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DATA: &str = r#"(function () { "use strict"; const data = {abbrvs:"LMT|EST|EDT",offsets:"0|-50|-40",zones:["America/New_York|,0,0,0|-1,1,1,0","Etc/UTC|,0,0,0"]}; data.links = {"US/Eastern":"America/New_York",UTC:"Etc/UTC","1918":"USback"}; return data; })"#;

    fn found(name: &str) -> Option<(String, &'static str)> {
        entries(DATA, name)
    }

    #[test]
    fn zones_links_and_offsets() {
        let new_york = Some(("America/New_York".to_owned(), ",0,0,0|-1,1,1,0"));
        assert_eq!(found("America/New_York"), new_york);
        assert_eq!(found("US/Eastern"), new_york);
        assert_eq!(found("UTC"), Some(("Etc/UTC".to_owned(), ",0,0,0")));
        assert_eq!(
            string_after(sections(DATA).unwrap().0, "offsets:\""),
            Some("0|-50|-40")
        );
    }

    #[test]
    fn names_outside_the_zone_list_are_unknown() {
        // An abbreviation, a link to no zone, a prefix or a suffix of a zone, a different case,
        // and names that could reach across entries.
        for name in [
            "LMT",
            "1918",
            "America/New",
            "New_York",
            "america/new_york",
            "",
            "a\"b",
            "x|y",
        ] {
            assert_eq!(found(name), None, "{name}");
        }
    }

    #[test]
    fn the_embedded_data_has_every_part() {
        let text = source().expect("tz_data.js is embedded");
        assert!(entries(text, "America/New_York").is_some());
        assert_eq!(
            entries(text, "Asia/Calcutta").map(|found| found.0),
            Some("Asia/Kolkata".to_owned())
        );
        let offsets = offsets_value().expect("offsets");
        assert!(matches!(offsets, Val::Str(text) if text.contains('|')));
    }
}
