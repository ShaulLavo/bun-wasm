import { intl } from "./namespace";
import { createCollator, type IntlInternal } from "./collator";

import "@formatjs/intl-pluralrules/locale-data/en.js";
import "@formatjs/intl-pluralrules/locale-data/de.js";
import "@formatjs/intl-pluralrules/locale-data/he.js";
import "@formatjs/intl-numberformat/locale-data/en.js";
import "@formatjs/intl-numberformat/locale-data/de.js";
import "@formatjs/intl-numberformat/locale-data/he.js";
import "@formatjs/intl-datetimeformat/locale-data/en.js";
import "@formatjs/intl-datetimeformat/locale-data/de.js";
import "@formatjs/intl-datetimeformat/locale-data/he.js";
import "@formatjs/intl-datetimeformat/add-all-tz.js";
import "@formatjs/intl-listformat/locale-data/en.js";
import "@formatjs/intl-listformat/locale-data/de.js";
import "@formatjs/intl-listformat/locale-data/he.js";
import "@formatjs/intl-relativetimeformat/locale-data/en.js";
import "@formatjs/intl-relativetimeformat/locale-data/de.js";
import "@formatjs/intl-relativetimeformat/locale-data/he.js";

export function createIntl(internal: IntlInternal) {
  const completeIntl = Object.assign({}, intl, { Collator: createCollator(internal) });
  Object.defineProperty(completeIntl, Symbol.toStringTag, { value: "Intl", configurable: true });
  Object.defineProperty(globalThis, "Intl", { value: completeIntl, writable: true, configurable: true, enumerable: false });
  return completeIntl;
}
