use std::cmp::Ordering;
use std::str::FromStr;

use icu_collator::options::{AlternateHandling, CaseLevel, CollatorOptions, MaxVariable, Strength};
use icu_collator::preferences::{CollationCaseFirst, CollationNumericOrdering, CollationType};
use icu_collator::{Collator, CollatorPreferences};
use icu_locale_core::Locale;
use icu_locale_core::extensions::unicode::Value;

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

fn case_first(value: &str) -> Result<CollationCaseFirst, NativeError> {
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

    let mut preferences = CollatorPreferences::from(locale);
    preferences.numeric_ordering = Some(if a.bool(2) {
        CollationNumericOrdering::True
    } else {
        CollationNumericOrdering::False
    });
    preferences.case_first = Some(case_first(a.str(3)?)?);
    if a.str(5)? != "default" {
        preferences.collation_type = Some(collation_type(a.str(5)?)?);
    }
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

pub fn install(t: &mut Table) {
    t.add("collatorCompare", compare);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swedish_places_umlaut_after_z() {
        let collator = Collator::try_new(
            icu_locale_core::locale!("sv").into(),
            CollatorOptions::default(),
        )
        .unwrap();
        assert_eq!(collator.compare("ä", "z"), Ordering::Greater);
    }

    #[test]
    fn numeric_ordering_compares_digit_runs_by_value() {
        let mut preferences = CollatorPreferences::from(icu_locale_core::locale!("en"));
        preferences.numeric_ordering = Some(CollationNumericOrdering::True);
        let collator = Collator::try_new(preferences, CollatorOptions::default()).unwrap();
        assert_eq!(collator.compare("item2", "item10"), Ordering::Less);
    }
}
