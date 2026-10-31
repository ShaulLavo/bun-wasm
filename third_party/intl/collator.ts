type Locales = string | string[];
type CollatorOptions = {
  usage?: string;
  localeMatcher?: string;
  collation?: string;
  numeric?: boolean;
  caseFirst?: string;
  sensitivity?: string;
  ignorePunctuation?: boolean;
};
type ResolvedCollatorOptions = {
  locale: string;
  usage: string;
  sensitivity: string;
  ignorePunctuation: boolean;
  collation: string;
  numeric: boolean;
  caseFirst: string;
};
type NegotiatedLocale = { requested: string; effective: string };
export type IntlInternal = {
  native: {
    collatorResolveLocale(locale: string): string | null;
    collatorCompare(
      locale: string,
      sensitivity: string,
      numeric: boolean | undefined,
      caseFirst: string | undefined,
      ignorePunctuation: boolean,
      collation: string,
      left: string,
      right: string,
    ): number;
  };
};

function option(value: string | undefined, allowed: readonly string[], fallback: string, name: string): string {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw new RangeError(`Invalid Intl.Collator ${name}: ${value}`);
  return value;
}

function negotiate(internal: IntlInternal, locales: readonly string[]): NegotiatedLocale[] {
  const selected: NegotiatedLocale[] = [];
  for (const requested of locales) {
    const effective = internal.native.collatorResolveLocale(requested);
    if (effective !== null) selected.push({ requested, effective });
  }
  return selected;
}

function resolvedLocale(locale: Intl.Locale, options: CollatorOptions): string {
  const extensions: string[] = [];
  if (locale.collation && (options.collation === undefined || options.collation === locale.collation)) {
    extensions.push("co", locale.collation);
  }
  if (locale.caseFirst && (options.caseFirst === undefined || options.caseFirst === locale.caseFirst)) {
    extensions.push("kf", locale.caseFirst);
  }
  const numericExtension = locale.toString().split("-u-")[1]?.split("-").includes("kn");
  if (numericExtension && (options.numeric === undefined || Boolean(options.numeric) === locale.numeric)) {
    extensions.push(locale.numeric ? "kn" : "kn-false");
  }
  return extensions.length ? `${locale.baseName}-u-${extensions.join("-")}` : locale.baseName;
}

export function createCollator(internal: IntlInternal) {
  return class Collator {
    #resolved: ResolvedCollatorOptions;
    #compareLocale: string;
    #numeric: boolean | undefined;
    #caseFirst: string | undefined;
    #collation: string;
    compare: (left: unknown, right: unknown) => number;

    constructor(locales?: Locales, options: CollatorOptions = {}) {
      const requested = Intl.getCanonicalLocales(locales);
      const usage = option(options.usage, ["sort", "search"], "sort", "usage");
      if (usage === "search") throw new RangeError("Intl.Collator search usage is not supported by this ICU4X data build");
      option(options.localeMatcher, ["lookup", "best fit"], "best fit", "localeMatcher");
      const selected = negotiate(internal, requested.length ? requested : ["en"])[0];
      this.#compareLocale = selected?.requested ?? "und";
      this.#numeric = options.numeric === undefined ? undefined : Boolean(options.numeric);
      this.#caseFirst = options.caseFirst === undefined ? undefined : option(options.caseFirst, ["upper", "lower", "false"], "false", "caseFirst");
      this.#collation = options.collation === undefined ? "default" : option(options.collation,
        ["default", "compat", "dict", "ducet", "emoji", "eor", "phonebk", "phonetic", "pinyin", "reformed", "standard", "stroke", "trad", "unihan", "zhuyin"], "default", "collation");
      const locale = new Intl.Locale(selected?.effective ?? "und");
      this.#resolved = {
        locale: resolvedLocale(locale, options),
        usage,
        sensitivity: option(options.sensitivity, ["base", "accent", "case", "variant"], "variant", "sensitivity"),
        ignorePunctuation: Boolean(options.ignorePunctuation),
        collation: this.#collation === "default" ? locale.collation ?? "default" : this.#collation,
        numeric: this.#numeric ?? locale.numeric,
        caseFirst: this.#caseFirst ?? locale.caseFirst ?? "false",
      };
      this.compare = (left, right) => internal.native.collatorCompare(this.#compareLocale, this.#resolved.sensitivity,
        this.#numeric, this.#caseFirst, this.#resolved.ignorePunctuation, this.#collation, String(left), String(right));
    }

    resolvedOptions(): ResolvedCollatorOptions {
      return { ...this.#resolved };
    }

    static supportedLocalesOf(locales?: Locales): string[] {
      const requested = Intl.getCanonicalLocales(locales);
      return negotiate(internal, requested).map(locale => locale.requested);
    }
  };
}
