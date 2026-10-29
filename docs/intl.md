# Intl fallback

QuickJS has no `Intl`. The WASI JavaScriptCore build has ICU with root and English data only. Engines with either limitation use the generated FormatJS bundle in `crates/bunwasm-runtime/src/js/intl.js`. The browser host keeps its native `Intl`.

Bootstrap checks German number formatting and Hebrew dual plurals on non-host engines. This detects partial locale data even when every constructor exists. The fallback uses a lazy global, but built-ins can initialize it during process startup.

## Supported behavior

The bundle supplies `NumberFormat`, `DateTimeFormat`, `PluralRules`, `Collator`, `Segmenter`, `ListFormat`, `RelativeTimeFormat`, `Locale`, `getCanonicalLocales`, and `supportedValuesOf`.

English, German, and Hebrew locale packs cover numbers, dates, plurals, lists, and relative times. Other requested locales fall back to English for these APIs. `supportedLocalesOf` reports the loaded packs. Segmentation uses the FormatJS package's Unicode rules.

ICU4X 2.4.0 implements collation with Unicode collation data and locale tailorings. The adapter supports sensitivity, numeric ordering, case-first, punctuation handling, and collation extensions. ICU4X falls back to its root data for unknown locales. Search usage is not included in this data build and throws `RangeError`.

Dates support the Gregorian and ISO 8601 calendars. The bundle includes FormatJS's complete IANA timezone data, with daylight transitions through 2100. The default timezone is UTC because a WASI guest has no host-local timezone contract. Named zones and explicit UTC offsets work without native engine support.

`DisplayNames`, `DurationFormat`, and non-Gregorian calendar packages are not bundled. There is no consumer for them yet. `DateTimeFormat` accepts `Date` and numeric inputs, but not Temporal objects. The previous fallback had the same Temporal limitation.

QuickJS and JavaScriptCore execute the same generated code and data. Native browser output can differ because browsers choose their own ICU and CLDR versions.

## Rebuild

Run `bun scripts/vendor-intl.ts`. The script installs the exact packages from `third_party/intl/bun.lock` in a temporary directory, bundles the TypeScript entry point, copies every bundled package's license, and removes the temporary directory. Package revisions and the selected locale imports live in `third_party/intl`.
