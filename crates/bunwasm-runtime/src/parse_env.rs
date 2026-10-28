//! Node's string-only dotenv API over Bun's existing Rust parser.

use crate::engine::{NativeError, NativeResult, Val};
use crate::natives::Table;

pub fn install(table: &mut Table) {
    table.add("parseEnv", |args| parse(args.str(0)?));
}

fn parse(content: &str) -> NativeResult {
    let mut loader = bun_dotenv::Loader::init();
    loader
        .load_from_string::<true, false>(content.as_bytes())
        .map_err(|_| NativeError::error("Out of memory"))?;
    let fields = loader
        .map
        .map
        .iter()
        .map(|(key, entry)| {
            (
                String::from_utf8_lossy(key).into_owned(),
                Val::Str(String::from_utf8_lossy(&entry.value).into_owned()),
            )
        })
        .collect();
    Ok(Val::Object(fields))
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
            let Val::Object(fields) = actual else {
                panic!("expected object")
            };
            let fields: std::collections::BTreeMap<_, _> = fields.into_iter().collect();
            let expected = expected
                .iter()
                .map(|(key, value)| (key.clone(), Val::Str(value.as_str().unwrap().to_owned())))
                .collect();
            assert_eq!(fields, expected, "{}", case["name"]);
        }
    }

    #[test]
    fn parse_env_registration_and_argument_boundary() {
        let mut table = Table::default();
        install(&mut table);
        let (name, function) = &table.functions[0];
        assert_eq!(*name, "parseEnv");
        assert_eq!(
            function(crate::engine::Args(&[Val::Str("A=1".into())])).unwrap(),
            parse("A=1").unwrap()
        );
        assert!(function(crate::engine::Args(&[Val::Null])).is_err());
    }
}
