//! Node's string-only dotenv API over Bun's existing Rust parser.

use crate::data::{NativeError, NativeResult, Val};
use crate::natives::Table;

pub fn install(table: &mut Table) {
    table.add("parseEnv", |args| parse(args.str(0)?));
}

fn parse(content: &str) -> NativeResult {
    let mut loader = bun_dotenv::Loader::init();
    loader
        .load_from_string::<true, false>(content.as_bytes())
        .map_err(|_| NativeError::error("Out of memory"))?;
    let entries = loader
        .map
        .map
        .iter()
        .map(|(key, entry)| {
            Val::Array(vec![
                Val::Str(String::from_utf8_lossy(key).into_owned()),
                Val::Str(String::from_utf8_lossy(&entry.value).into_owned()),
            ])
        })
        .collect();
    Ok(Val::Array(entries))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_env_matches_native_oracles() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/util-parse-env/cases.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let actual = parse(case["source"].as_str().unwrap()).unwrap();
            let expected = case["expected"].as_object().unwrap();
            let Val::Array(entries) = actual else {
                panic!("expected entries")
            };
            let fields: std::collections::BTreeMap<_, _> = entries.into_iter().map(entry).collect();
            let expected = expected
                .iter()
                .map(|(key, value)| (key.clone(), Val::Str(value.as_str().unwrap().to_owned())))
                .collect();
            assert_eq!(fields, expected, "{}", case["name"]);
        }
    }

    fn entry(value: Val) -> (String, Val) {
        let Val::Array(pair) = value else {
            panic!("expected pair")
        };
        let mut pair = pair.into_iter();
        let Some(Val::Str(key)) = pair.next() else {
            panic!("expected key")
        };
        let value = pair.next().expect("expected value");
        assert_eq!(pair.next(), None);
        (key, value)
    }

    #[test]
    fn parse_env_registration_and_argument_boundary() {
        let mut table = Table::default();
        install(&mut table);
        let (name, function) = &table.functions[0];
        assert_eq!(*name, "parseEnv");
        assert_eq!(
            function(crate::data::Args(&[Val::Str("A=1".into())])).unwrap(),
            parse("A=1").unwrap()
        );
        assert!(function(crate::data::Args(&[Val::Null])).is_err());
    }
}
