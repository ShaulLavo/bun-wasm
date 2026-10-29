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
export type IntlInternal = {
  native: {
    collatorCompare(
      locale: string,
      sensitivity: string,
      numeric: boolean,
      caseFirst: string,
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

export function createCollator(internal: IntlInternal) {
  return class Collator {
    #resolved: ResolvedCollatorOptions;
    compare: (left: unknown, right: unknown) => number;

    constructor(locales?: Locales, options: CollatorOptions = {}) {
      const requested = Intl.getCanonicalLocales(locales);
      const usage = option(options.usage, ["sort", "search"], "sort", "usage");
      if (usage === "search") throw new RangeError("Intl.Collator search usage is not supported by this ICU4X data build");
      option(options.localeMatcher, ["lookup", "best fit"], "best fit", "localeMatcher");
      this.#resolved = {
        locale: requested[0] ?? "en",
        usage,
        sensitivity: option(options.sensitivity, ["base", "accent", "case", "variant"], "variant", "sensitivity"),
        ignorePunctuation: Boolean(options.ignorePunctuation),
        collation: option(options.collation, ["default", "compat", "dict", "ducet", "emoji", "eor", "phonebk", "phonetic", "pinyin", "reformed", "standard", "stroke", "trad", "unihan", "zhuyin"], "default", "collation"),
        numeric: Boolean(options.numeric),
        caseFirst: option(options.caseFirst, ["upper", "lower", "false"], "false", "caseFirst"),
      };
      this.compare = (left, right) => {
        const o = this.#resolved;
        return internal.native.collatorCompare(o.locale, o.sensitivity, o.numeric, o.caseFirst,
          o.ignorePunctuation, o.collation, String(left), String(right));
      };
    }

    resolvedOptions(): ResolvedCollatorOptions {
      return { ...this.#resolved };
    }

    static supportedLocalesOf(locales?: Locales): string[] {
      return Intl.getCanonicalLocales(locales);
    }
  };
}
