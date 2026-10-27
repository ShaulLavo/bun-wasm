// A small `Intl` for QuickJS, which ships none. English ("en-US") only:
// enough for libraries that feature-detect or format simple values
// (string-width's Intl.Segmenter, toLocaleString-style number grouping,
// Collator-based sorting). Not a locale database.
(function (internal: BunWasm.Internal) {
  "use strict";
  void internal;

  type Locales = string | readonly string[];
  type Part = { type: string; value: string };
  type Segment = { segment: string; index: number; input: string; isWordLike?: boolean };
  type NumberOptions = {
    style?: string; currency?: string; unit?: string; minimumIntegerDigits?: number;
    minimumFractionDigits?: number; maximumFractionDigits?: number; useGrouping?: boolean;
    notation?: string; signDisplay?: string;
  };
  type DateOptions = {
    weekday?: string; year?: string; month?: string; day?: string; hour?: string;
    minute?: string; second?: string; era?: string; dateStyle?: string; timeStyle?: string;
    timeZone?: string; hour12?: boolean; hourCycle?: string;
  };
  type DateInput = string | number | Date;

  const LOCALE = "en-US";

  function resolveLocale() {
    return LOCALE;
  }

  // --- Segmenter ----------------------------------------------------------------

  // Code points that attach to the previous one in a grapheme cluster.
  function isExtending(cp: number) {
    return (
      (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) ||
      (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xfe20 && cp <= 0xfe2f) ||
      (cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0xe0020 && cp <= 0xe007f) || cp === 0x200d ||
      (cp >= 0x0900 && cp <= 0x0903) || (cp >= 0x093a && cp <= 0x094f) || (cp >= 0x0e31 && cp <= 0x0e3a && cp !== 0x0e32)
    );
  }

  const isRegional = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
  const isWordChar = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);

  function graphemes(str: string) {
    const out = [];
    let current = "";
    let prevZwj = false;
    let regionalRun = 0;
    for (const ch of str) {
      const cp = ch.codePointAt(0)!;
      const joins = current !== "" && (isExtending(cp) || prevZwj || (isRegional(cp) && regionalRun % 2 === 1) || (ch === "\n" && current === "\r"));
      if (joins) {
        current += ch;
      } else {
        if (current !== "") out.push(current);
        current = ch;
        regionalRun = 0;
      }
      if (isRegional(cp)) regionalRun++;
      prevZwj = cp === 0x200d;
    }
    if (current !== "") out.push(current);
    return out;
  }

  function words(str: string) {
    const out = [];
    const re = /[\p{L}\p{N}_'’]+|\s+|[^\p{L}\p{N}_\s]/gu;
    let m;
    while ((m = re.exec(str)) !== null) out.push(m[0]);
    return out;
  }

  function sentences(str: string) {
    const out = [];
    const re = /[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g;
    let m;
    while ((m = re.exec(str)) !== null && m[0] !== "") out.push(m[0]);
    return out;
  }

  class Segmenter {
    #granularity;
    constructor(locales?: Locales, options: { granularity?: string } = {}) {
      this.#granularity = options.granularity || "grapheme";
      if (!["grapheme", "word", "sentence"].includes(this.#granularity)) {
        throw new RangeError(`Value ${this.#granularity} out of range for Intl.Segmenter options property granularity`);
      }
    }
    segment(input: unknown) {
      const str = String(input);
      const granularity = this.#granularity;
      const pieces = granularity === "word" ? words(str) : granularity === "sentence" ? sentences(str) : graphemes(str);
      const segments: Segment[] = [];
      let index = 0;
      for (const segment of pieces) {
        const entry: Segment = { segment, index, input: str };
        if (granularity === "word") entry.isWordLike = isWordChar(segment[0]);
        segments.push(entry);
        index += segment.length;
      }
      return {
        [Symbol.iterator]: () => segments[Symbol.iterator](),
        containing(i = 0) {
          return segments.find((s) => i >= s.index && i < s.index + s.segment.length);
        },
      };
    }
    resolvedOptions() {
      return { locale: LOCALE, granularity: this.#granularity };
    }
    static supportedLocalesOf() {
      return [LOCALE];
    }
  }

  // --- NumberFormat -------------------------------------------------------------

  function groupDigits(intPart: string, separator: string) {
    return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  }

  const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹", CNY: "CN¥", KRW: "₩", ILS: "₪" };

  class NumberFormat {
    #options;
    constructor(locales?: Locales, options: NumberOptions = {}) {
      const style = options.style || "decimal";
      const currencyDigits = style === "currency" ? (options.currency === "JPY" ? 0 : 2) : 0;
      const minFD = options.minimumFractionDigits ?? (style === "currency" ? currencyDigits : 0);
      const maxFD = options.maximumFractionDigits ?? Math.max(minFD, style === "currency" ? currencyDigits : style === "percent" ? 0 : 3);
      this.#options = {
        locale: LOCALE,
        numberingSystem: "latn",
        style,
        currency: options.currency ? String(options.currency).toUpperCase() : undefined,
        unit: options.unit,
        minimumIntegerDigits: options.minimumIntegerDigits ?? 1,
        minimumFractionDigits: minFD,
        maximumFractionDigits: maxFD,
        useGrouping: options.useGrouping ?? true,
        notation: options.notation || "standard",
        signDisplay: options.signDisplay || "auto",
      };
    }
    format(value: unknown) {
      const o = this.#options;
      let n = typeof value === "bigint" ? Number(value) : Number(value);
      if (Number.isNaN(n)) return "NaN";
      if (!Number.isFinite(n)) return n < 0 ? "-∞" : "∞";
      if (o.style === "percent") n *= 100;
      if (o.notation === "compact") return compact(n);
      const negative = n < 0 || Object.is(n, -0);
      let fixed = Math.abs(n).toFixed(o.maximumFractionDigits);
      if (fixed.includes(".")) {
        fixed = fixed.replace(/0+$/, "");
        const [i, f = ""] = fixed.split(".");
        fixed = f.length < o.minimumFractionDigits ? `${i}.${f.padEnd(o.minimumFractionDigits, "0")}` : f ? `${i}.${f}` : i;
      }
      let [intPart, frac] = fixed.split(".");
      intPart = intPart.padStart(o.minimumIntegerDigits, "0");
      if (o.useGrouping) intPart = groupDigits(intPart, ",");
      let body = frac ? `${intPart}.${frac}` : intPart;
      if (o.style === "percent") body += "%";
      if (o.style === "currency") body = (CURRENCY_SYMBOLS[o.currency!] || `${o.currency} `) + body;
      if (o.style === "unit" && o.unit) body += ` ${o.unit}`;
      const showMinus = negative && Math.abs(n) !== 0;
      if (showMinus) return `-${body}`;
      if (o.signDisplay === "always" || (o.signDisplay === "exceptZero" && n !== 0)) return `+${body}`;
      return body;
    }
    formatToParts(value: unknown) {
      return [{ type: "literal", value: this.format(value) }];
    }
    resolvedOptions() {
      return Object.assign({}, this.#options);
    }
    static supportedLocalesOf() {
      return [LOCALE];
    }
  }

  function compact(n: number) {
    const abs = Math.abs(n);
    const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    for (const [size, suffix] of units) {
      if (abs >= size) {
        const v = n / size;
        return `${Number(v.toFixed(Math.abs(v) < 10 ? 1 : 0))}${suffix}`;
      }
    }
    return String(Number(n.toFixed(0)));
  }

  // --- DateTimeFormat -----------------------------------------------------------

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  class DateTimeFormat {
    #options;
    constructor(locales?: Locales, options: DateOptions = {}) {
      const hasField = ["weekday", "year", "month", "day", "hour", "minute", "second"].some((k) => options[k as keyof DateOptions] !== undefined);
      const base = hasField || options.dateStyle || options.timeStyle ? {} : { year: "numeric", month: "numeric", day: "numeric" };
      this.#options = Object.assign({ locale: LOCALE, calendar: "gregory", numberingSystem: "latn", timeZone: options.timeZone || "UTC" }, base, options);
    }
    format(date: DateInput = Date.now()) {
      const d = new Date(date);
      if (Number.isNaN(d.getTime())) throw new RangeError("Invalid time value");
      return this.formatToParts(d).map((p) => p.value).join("");
    }
    formatToParts(date: DateInput = Date.now()) {
      const d = new Date(date);
      const o = this.#options;
      const utc = o.timeZone === "UTC";
      const get = (local: (this: Date) => number, u: (this: Date) => number) => (utc ? u.call(d) : local.call(d));
      const year = get(d.getFullYear, d.getUTCFullYear);
      const month = get(d.getMonth, d.getUTCMonth);
      const day = get(d.getDate, d.getUTCDate);
      const weekday = get(d.getDay, d.getUTCDay);
      const hour = get(d.getHours, d.getUTCHours);
      const minute = get(d.getMinutes, d.getUTCMinutes);
      const second = get(d.getSeconds, d.getUTCSeconds);
      const parts: Part[] = [];
      const push = (type: string, value: string | number) => parts.push({ type, value: String(value) });
      const lit = (value: string) => parts.push({ type: "literal", value });
      const appendTimeParts = () => {
        if (o.era) {
          const part = parts.find((p) => p.type === "year");
          if (part && year <= 0) part.value = String(1 - year);
          lit(" ");
          push("era", o.era === "long" ? (year <= 0 ? "Before Christ" : "Anno Domini") : year <= 0 ? "BC" : "AD");
        }
        const wantsTime = o.timeStyle || o.hour !== undefined || o.minute !== undefined;
        if (wantsTime) {
          if (parts.length) lit(", ");
          const h12 = o.hour12 !== false && o.hourCycle !== "h23";
          const h = h12 ? hour % 12 || 12 : hour;
          push("hour", o.hour === "2-digit" || !h12 ? String(h).padStart(2, "0") : h);
          lit(":");
          push("minute", String(minute).padStart(2, "0"));
          if (o.second !== undefined || o.timeStyle === "medium" || o.timeStyle === "long" || o.timeStyle === "full") {
            lit(":");
            push("second", String(second).padStart(2, "0"));
          }
          if (h12) {
            lit(" ");
            push("dayPeriod", hour < 12 ? "AM" : "PM");
          }
        }
      };
      const style = o.dateStyle;
      if (style === "full" || style === "long" || style === "medium") {
        if (style === "full") {
          push("weekday", DAYS[weekday]);
          lit(", ");
        }
        push("month", style === "medium" ? MONTHS[month].slice(0, 3) : MONTHS[month]);
        lit(" ");
        push("day", day);
        lit(", ");
        push("year", year);
      } else if (style === "short" || o.month === "numeric" || o.month === "2-digit") {
        push("month", o.month === "2-digit" ? String(month + 1).padStart(2, "0") : month + 1);
        lit("/");
        push("day", o.day === "2-digit" ? String(day).padStart(2, "0") : day);
        lit("/");
        push("year", style === "short" || o.year === "2-digit" ? String(year).slice(-2) : year);
      } else {
        if (o.weekday) push("weekday", o.weekday === "long" ? DAYS[weekday] : DAYS[weekday].slice(0, 3));
        if (o.weekday && (o.month || o.day)) lit(", ");
        if (o.month) push("month", o.month === "long" ? MONTHS[month] : MONTHS[month].slice(0, 3));
        if (o.month && o.day) lit(" ");
        if (o.day) push("day", day);
        if (o.year && (o.month || o.day)) lit(", ");
        if (o.year) push("year", o.year === "2-digit" ? String(year).slice(-2) : year);
      }
      appendTimeParts();
      return parts;
    }
    formatRange(a: DateInput, b: DateInput) {
      return `${this.format(a)} – ${this.format(b)}`;
    }
    resolvedOptions() {
      return Object.assign({}, this.#options);
    }
    static supportedLocalesOf() {
      return [LOCALE];
    }
  }

  // --- Collator, PluralRules, ListFormat, RelativeTimeFormat ---------------------

  class Collator {
    #options;
    constructor(locales?: Locales, options: { usage?: string; sensitivity?: string; numeric?: unknown } = {}) {
      this.#options = { locale: LOCALE, usage: options.usage || "sort", sensitivity: options.sensitivity || "variant", numeric: Boolean(options.numeric), caseFirst: "false", ignorePunctuation: false, collation: "default" };
      this.compare = this.compare.bind(this);
    }
    compare(a: unknown, b: unknown) {
      let x = String(a);
      let y = String(b);
      if (this.#options.sensitivity === "base" || this.#options.sensitivity === "accent") {
        x = x.toLowerCase();
        y = y.toLowerCase();
      }
      if (this.#options.numeric) {
        const nx = x.match(/^\d+/);
        const ny = y.match(/^\d+/);
        if (nx && ny && nx[0] !== ny[0]) return Number(nx[0]) - Number(ny[0]) < 0 ? -1 : 1;
      }
      const lx = x.toLowerCase();
      const ly = y.toLowerCase();
      if (lx !== ly) return lx < ly ? -1 : 1;
      return x === y ? 0 : x < y ? 1 : -1;
    }
    resolvedOptions() {
      return Object.assign({}, this.#options);
    }
    static supportedLocalesOf() {
      return [LOCALE];
    }
  }

  class PluralRules {
    #type;
    constructor(locales?: Locales, options: { type?: string } = {}) {
      this.#type = options.type || "cardinal";
    }
    select(n: unknown) {
      const v = Number(n);
      if (this.#type === "ordinal") {
        const ten = v % 10;
        const hundred = v % 100;
        if (ten === 1 && hundred !== 11) return "one";
        if (ten === 2 && hundred !== 12) return "two";
        if (ten === 3 && hundred !== 13) return "few";
        return "other";
      }
      return v === 1 ? "one" : "other";
    }
    resolvedOptions() {
      return { locale: LOCALE, type: this.#type, pluralCategories: this.#type === "ordinal" ? ["few", "one", "two", "other"] : ["one", "other"] };
    }
    static supportedLocalesOf() {
      return [LOCALE];
    }
  }

  class ListFormat {
    #type;
    constructor(locales?: Locales, options: { type?: string } = {}) {
      this.#type = options.type || "conjunction";
    }
    format(list: Iterable<unknown>) {
      const items = Array.from(list, String);
      const word = this.#type === "disjunction" ? "or" : "and";
      if (items.length <= 1) return items.join("");
      if (items.length === 2) return `${items[0]} ${word} ${items[1]}`;
      return `${items.slice(0, -1).join(", ")}, ${word} ${items[items.length - 1]}`;
    }
  }

  class RelativeTimeFormat {
    #numeric;
    constructor(locales?: Locales, options: { numeric?: string } = {}) {
      this.#numeric = options.numeric || "always";
    }
    format(value: unknown, unit: unknown) {
      const v = Number(value);
      const u = String(unit).replace(/s$/, "");
      if (this.#numeric === "auto" && u === "day" && Math.abs(v) <= 1) return v === 0 ? "today" : v > 0 ? "tomorrow" : "yesterday";
      const abs = Math.abs(v);
      const label = `${abs} ${u}${abs === 1 ? "" : "s"}`;
      return v < 0 || Object.is(v, -0) ? `${label} ago` : `in ${label}`;
    }
  }

  class Locale {
    declare baseName: string;
    declare language: string;
    declare region: string | undefined;
    constructor(tag: unknown) {
      this.baseName = String(tag);
      const [language, region] = this.baseName.split("-");
      this.language = language;
      this.region = region;
    }
    toString() {
      return this.baseName;
    }
    maximize() {
      return this;
    }
    minimize() {
      return this;
    }
  }

  const Intl = {
    Segmenter,
    NumberFormat,
    DateTimeFormat,
    Collator,
    PluralRules,
    ListFormat,
    RelativeTimeFormat,
    Locale,
    getCanonicalLocales: (locales?: unknown) => (locales === undefined ? [] : Array.isArray(locales) ? locales.map(String) : [String(locales)]),
    supportedValuesOf: () => [],
  };
  Object.defineProperty(Intl, Symbol.toStringTag, { value: "Intl", configurable: true });
  void resolveLocale;
  return Intl;
})
