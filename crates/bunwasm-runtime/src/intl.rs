use std::cmp::Ordering;
use std::str::FromStr;

use icu_collator::options::{AlternateHandling, CaseLevel, CollatorOptions, MaxVariable, Strength};
use icu_collator::preferences::{CollationCaseFirst, CollationNumericOrdering, CollationType};
use icu_collator::provider::{Baked, CollationMetadataV1, CollationRootV1, CollationTailoringV1};
use icu_collator::{Collator, CollatorPreferences};
use icu_locale_core::Locale;
use icu_locale_core::extensions::unicode::{Value, key};
use icu_locale_fallback::{LocaleFallbackConfig, LocaleFallbackPriority, LocaleFallbacker};
use icu_provider::marker::DataMarkerExt;
use icu_provider::{
    DataIdentifierBorrowed, DataLocale, DataMarkerAttributes, DataProvider, DataRequest,
};

use crate::data::{Args, NativeError, NativeResult, Val};
use crate::natives::Table;

fn strength(sensitivity: &str) -> Result<Strength, NativeError> {
    match sensitivity {
        "base" | "case" => Ok(Strength::Primary),
        "accent" => Ok(Strength::Secondary),
        "variant" => Ok(Strength::Tertiary),
        _ => Err(NativeError::error(format!(
            "Invalid collation sensitivity: {sensitivity}"
        ))),
    }
}

fn parse_case_first(value: &str) -> Result<CollationCaseFirst, NativeError> {
    match value {
        "upper" => Ok(CollationCaseFirst::Upper),
        "lower" => Ok(CollationCaseFirst::Lower),
        "false" => Ok(CollationCaseFirst::False),
        _ => Err(NativeError::error(format!(
            "Invalid collation caseFirst: {value}"
        ))),
    }
}

fn collation_type(input: &str) -> Result<CollationType, NativeError> {
    let value = Value::from_str(input)
        .map_err(|error| NativeError::error(format!("Invalid collation value: {error}")))?;
    CollationType::try_from(&value)
        .map_err(|error| NativeError::error(format!("Invalid collation type: {error}")))
}

fn preferences(
    locale: Locale,
    numeric: Option<bool>,
    case_first: Option<&str>,
    collation: &str,
) -> Result<CollatorPreferences, NativeError> {
    let mut preferences = CollatorPreferences::from(locale);
    if let Some(numeric) = numeric {
        preferences.numeric_ordering = Some(if numeric {
            CollationNumericOrdering::True
        } else {
            CollationNumericOrdering::False
        });
    }
    if let Some(case_first) = case_first {
        preferences.case_first = Some(parse_case_first(case_first)?);
    }
    if collation != "default" {
        preferences.collation_type = Some(collation_type(collation)?);
    }
    Ok(preferences)
}

fn compare(a: Args<'_>) -> NativeResult {
    let locale = a
        .str(0)?
        .parse::<Locale>()
        .map_err(|error| NativeError::error(format!("Invalid collation locale: {error}")))?;
    let sensitivity = a.str(1)?;
    let mut options = CollatorOptions::default();
    options.strength = Some(strength(sensitivity)?);
    options.case_level = Some(if sensitivity == "case" {
        CaseLevel::On
    } else {
        CaseLevel::Off
    });
    if a.bool(4) {
        options.alternate_handling = Some(AlternateHandling::Shifted);
        options.max_variable = Some(MaxVariable::Punctuation);
    }

    let numeric = if a.is_missing(2) {
        None
    } else {
        Some(a.bool(2))
    };
    let case_first = if a.is_missing(3) {
        None
    } else {
        Some(a.str(3)?)
    };
    let preferences = preferences(locale, numeric, case_first, a.str(5)?)?;
    let collator = Collator::try_new(preferences, options)
        .map_err(|error| NativeError::error(format!("Unable to create collator: {error}")))?;
    let ordering = collator.compare(a.str(6)?, a.str(7)?);
    Ok(match ordering {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
    .into())
}

fn has_collation_data(locale: &DataLocale) -> bool {
    let request = DataRequest {
        id: DataIdentifierBorrowed::for_locale(locale),
        metadata: Default::default(),
    };
    <Baked as DataProvider<CollationTailoringV1>>::load(&Baked, request).is_ok()
}

fn has_root_collation_data() -> bool {
    <Baked as DataProvider<CollationRootV1>>::load(&Baked, Default::default()).is_ok()
}

fn has_known_language(locale: &DataLocale) -> bool {
    if locale.language.is_unknown() {
        return true;
    }
    let mut language_only = *locale;
    language_only.script = None;
    language_only.region = None;
    language_only.variant = None;
    language_only.subdivision = None;
    let mut config = LocaleFallbackConfig::default();
    config.priority = LocaleFallbackPriority::Region;
    let normalized = LocaleFallbacker::new()
        .for_config(config)
        .fallback_for(language_only);
    normalized.take().region.is_some()
}

fn has_collation_type(locale: &DataLocale, collation: CollationType) -> bool {
    let mut request = DataRequest {
        id: DataIdentifierBorrowed::for_marker_attributes_and_locale(
            DataMarkerAttributes::from_str_or_panic(collation.as_str()),
            locale,
        ),
        metadata: Default::default(),
    };
    request.metadata.silent = true;
    <Baked as DataProvider<CollationMetadataV1>>::load(&Baked, request).is_ok()
}

fn resolved_locale_tag(effective: DataLocale, requested: &Locale) -> String {
    let preferences = CollatorPreferences::from(requested.clone());
    let collation_supported = preferences
        .collation_type
        .is_some_and(|collation| has_collation_type(&effective, collation));
    let mut resolved = effective.into_locale();
    for (key, supported) in [
        (key!("co"), collation_supported),
        (key!("kf"), preferences.case_first.is_some()),
        (key!("kn"), preferences.numeric_ordering.is_some()),
    ] {
        if !supported {
            continue;
        }
        let Some(value) = requested.extensions.unicode.keywords.get(&key) else {
            continue;
        };
        resolved.extensions.unicode.keywords.set(key, value.clone());
    }
    resolved.to_string()
}

fn resolve_locale(input: &str) -> Result<Option<String>, NativeError> {
    let locale = input
        .parse::<Locale>()
        .map_err(|error| NativeError::error(format!("Invalid collation locale: {error}")))?;
    let data_locale = CollationTailoringV1::make_locale(
        CollatorPreferences::from(locale.clone()).locale_preferences,
    );
    if !has_known_language(&data_locale) {
        return Ok(None);
    }
    let mut fallback = LocaleFallbacker::new()
        .for_config(Default::default())
        .fallback_for(data_locale);
    let mut effective = *fallback.get();
    loop {
        if has_collation_data(fallback.get()) {
            return Ok(Some(resolved_locale_tag(*fallback.get(), &locale)));
        }
        if fallback.get().is_unknown() {
            if !has_root_collation_data() {
                return Ok(None);
            }
            return Ok(Some(resolved_locale_tag(effective, &locale)));
        }
        effective = *fallback.get();
        fallback.step();
    }
}

fn resolve(a: Args<'_>) -> NativeResult {
    Ok(resolve_locale(a.str(0)?)?.map_or(Val::Null, Val::from))
}

pub fn install(t: &mut Table) {
    t.add("collatorCompare", compare);
    t.add("collatorResolveLocale", resolve);
}

#[cfg(test)]
mod tests {
    use super::*;
    use icu_locale_core::locale;

    fn compare_with(
        locale: Locale,
        numeric: Option<bool>,
        case_first: Option<&str>,
        left: &str,
        right: &str,
    ) -> Ordering {
        let preferences = preferences(locale, numeric, case_first, "default").unwrap();
        Collator::try_new(preferences, CollatorOptions::default())
            .unwrap()
            .compare(left, right)
    }

    #[test]
    fn swedish_places_umlaut_after_z() {
        assert_eq!(
            compare_with(locale!("sv"), None, None, "ä", "z"),
            Ordering::Greater
        );
    }

    #[test]
    fn locale_extensions_override_defaults_until_explicit_options() {
        assert_eq!(
            compare_with(locale!("en-u-kn"), None, None, "item2", "item10"),
            Ordering::Less
        );
        assert_eq!(
            compare_with(locale!("en-u-kn"), Some(false), None, "item2", "item10"),
            Ordering::Greater
        );
        assert_eq!(
            compare_with(locale!("en-u-kf-upper"), None, None, "A", "a"),
            Ordering::Less
        );
        assert_eq!(
            compare_with(locale!("en-u-kf-upper"), None, Some("false"), "A", "a"),
            Ordering::Greater
        );
    }

    #[test]
    fn negotiation_uses_actual_collation_data() {
        assert_eq!(resolve_locale("sv").unwrap().as_deref(), Some("sv"));
        assert_eq!(resolve_locale("en-US").unwrap().as_deref(), Some("en"));
        assert_eq!(resolve_locale("zz-ZZ").unwrap(), None);
        assert_eq!(resolve_locale("xx").unwrap(), None);
        assert_eq!(resolve_locale("und").unwrap().as_deref(), Some("und"));
    }

    #[test]
    fn native_resolver_returns_null_for_unsupported_locales() {
        assert_eq!(resolve(Args(&[Val::from("zz-ZZ")])).unwrap(), Val::Null);
        assert_eq!(resolve(Args(&[Val::from("sv")])).unwrap(), Val::from("sv"));
    }

    #[test]
    fn native_resolver_preserves_supported_collation_extensions() {
        for (input, expected) in [
            ("en-u-kn", "en-u-kn"),
            ("en-u-kn-false", "en-u-kn-false"),
            ("en-u-kf-upper", "en-u-kf-upper"),
            ("de-u-co-phonebk", "de-u-co-phonebk"),
            ("de-u-co-phonebk-kf-upper-kn", "de-u-co-phonebk-kf-upper-kn"),
            ("en-u-co-phonebk", "en"),
            ("en-u-ca-gregory-kn", "en-u-kn"),
        ] {
            assert_eq!(
                resolve(Args(&[Val::from(input)])).unwrap(),
                Val::from(expected)
            );
        }
    }

    #[test]
    fn native_comparison_applies_sensitivity_and_punctuation_options() {
        let args = [
            Val::from("en"),
            Val::from("base"),
            Val::Undefined,
            Val::Undefined,
            Val::from(false),
            Val::from("default"),
            Val::from("a"),
            Val::from("ä"),
        ];
        assert_eq!(compare(Args(&args)).unwrap(), Val::from(0));
        let mut args = args;
        args[1] = Val::from("variant");
        args[4] = Val::from(true);
        args[6] = Val::from("a-b");
        args[7] = Val::from("ab");
        assert_eq!(compare(Args(&args)).unwrap(), Val::from(0));
        args[4] = Val::from(false);
        assert_eq!(compare(Args(&args)).unwrap(), Val::from(-1));
    }
}
