import { getCanonicalLocales } from "@formatjs/intl-getcanonicallocales";
import { Locale } from "@formatjs/intl-locale";
import { PluralRules } from "@formatjs/intl-pluralrules";
import { NumberFormat } from "@formatjs/intl-numberformat";
import { DateTimeFormat } from "@formatjs/intl-datetimeformat";
import { Collator } from "@formatjs/intl-collator";
import { Segmenter } from "@formatjs/intl-segmenter";
import ListFormat from "@formatjs/intl-listformat";
import RelativeTimeFormat from "@formatjs/intl-relativetimeformat";
import { supportedValuesOf } from "@formatjs/intl-supportedvaluesof";

export const intl = {
  getCanonicalLocales,
  Locale,
  PluralRules,
  NumberFormat,
  DateTimeFormat,
  Collator,
  Segmenter,
  ListFormat,
  RelativeTimeFormat,
  supportedValuesOf,
};

// FormatJS locale modules register through this global. The generated wrapper
// replaces bootstrap's lazy getter before the ponyfill modules initialize.
Object.defineProperty(globalThis, "Intl", {
  value: intl,
  writable: true,
  configurable: true,
  enumerable: false,
});
Object.defineProperty(intl, Symbol.toStringTag, { value: "Intl", configurable: true });
