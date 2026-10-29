use std::cmp::Ordering;
use std::str::FromStr;

use icu_collator::options::{AlternateHandling, CaseLevel, CollatorOptions, MaxVariable, Strength};
use icu_collator::preferences::{CollationCaseFirst, CollationNumericOrdering, CollationType};
use icu_collator::provider::{Baked, CollationRootV1, CollationTailoringV1};
use icu_collator::{Collator, CollatorPreferences};
use icu_locale_core::Locale;
use icu_locale_core::extensions::unicode::Value;
use icu_locale_fallback::{LocaleFallbackConfig, LocaleFallbackPriority, LocaleFallbacker};
use icu_provider::marker::DataMarkerExt;
use icu_provider::{DataIdentifierBorrowed, DataLocale, DataProvider, DataRequest};

use crate::data::{Args, NativeError, NativeResult};
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
        if sensitivity == "variant" {
            options.strength = Some(Strength::Quaternary);
        }
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

fn resolve_locale(input: &str) -> Result<Option<String>, NativeError> {
    let locale = input
        .parse::<Locale>()
        .map_err(|error| NativeError::error(format!("Invalid collation locale: {error}")))?;
    let data_locale =
        CollationTailoringV1::make_locale(CollatorPreferences::from(locale).locale_preferences);
    if !has_known_language(&data_locale) {
        return Ok(None);
    }
    let mut fallback = LocaleFallbacker::new()
        .for_config(Default::default())
        .fallback_for(data_locale);
    let mut effective = *fallback.get();
    loop {
        if has_collation_data(fallback.get()) {
            return Ok(Some(fallback.get().to_string()));
        }
        if fallback.get().is_unknown() {
            if !has_root_collation_data() {
                return Ok(None);
            }
            return Ok(Some(effective.to_string()));
        }
        effective = *fallback.get();
        fallback.step();
    }
}

fn resolve(a: Args<'_>) -> NativeResult {
    Ok(resolve_locale(a.str(0)?)?.into())
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
}
