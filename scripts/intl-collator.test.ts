import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/intl.js", import.meta.url), "utf8");
const nativeIntl = Intl;
type NativeCollatorOptions = NonNullable<ConstructorParameters<typeof Intl.Collator>[1]>;
type CallbackArgs = [string, NativeCollatorOptions["sensitivity"], NativeCollatorOptions["numeric"], NativeCollatorOptions["caseFirst"], NativeCollatorOptions["ignorePunctuation"], NativeCollatorOptions["collation"], string, string];

function factoryWithNativeCallback() {
  const calls: CallbackArgs[] = [];
  const context = vm.createContext({});
  const fallback = vm.runInContext(source, context)({ native: {
    collatorResolveLocale(locale: string): string | null {
      if (nativeIntl.Collator.supportedLocalesOf([locale]).length === 0) return null;
      return new nativeIntl.Collator(locale).resolvedOptions().locale;
    },
    collatorCompare(...args: CallbackArgs): number {
      calls.push(args);
      const [locale, sensitivity, numeric, caseFirst, ignorePunctuation, collation, left, right] = args;
      return Math.sign(new nativeIntl.Collator(locale, {
        sensitivity,
        numeric,
        caseFirst,
        ignorePunctuation,
        collation,
      }).compare(left, right));
    },
  } });
  return { fallback, calls };
}

test("generated factory preserves extension defaults and explicit option precedence through the native callback", () => {
  const { fallback, calls } = factoryWithNativeCallback();
  const numeric = new fallback.Collator("en-u-kn");
  expect(numeric.compare("item2", "item10")).toBe(-1);
  expect(numeric.resolvedOptions().numeric).toBe(true);
  expect(calls.at(-1)?.slice(0, 6)).toEqual(["en-u-kn", "variant", undefined, undefined, false, "default"]);

  const numericOff = new fallback.Collator("en-u-kn", { numeric: false });
  expect(numericOff.compare("item2", "item10")).toBe(1);
  expect(numericOff.resolvedOptions().numeric).toBe(false);
  expect(calls.at(-1)?.[2]).toBe(false);

  const upper = new fallback.Collator("en-u-kf-upper");
  expect(upper.compare("A", "a")).toBe(-1);
  expect(upper.resolvedOptions().caseFirst).toBe("upper");
  expect(calls.at(-1)?.[3]).toBeUndefined();

  const upperOff = new fallback.Collator("en-u-kf-upper", { caseFirst: "false" });
  expect(upperOff.compare("A", "a")).toBe(1);
  expect(upperOff.resolvedOptions().caseFirst).toBe("false");
  expect(calls.at(-1)?.[3]).toBe("false");

  const phonebook = new fallback.Collator("de-u-co-phonebk");
  expect(phonebook.compare("ä", "ae")).toBe(1);
  expect(phonebook.resolvedOptions().collation).toBe("phonebk");
  expect(calls.at(-1)?.[5]).toBe("default");
});

test("generated factory negotiates locales through the native resolver callback", () => {
  const { fallback, calls } = factoryWithNativeCallback();
  const swedish = new fallback.Collator(["zz-ZZ", "sv"]);
  expect(swedish.compare("ä", "z")).toBe(1);
  expect(swedish.resolvedOptions().locale).toBe("sv");
  expect(calls.at(-1)?.[0]).toBe("sv");
  expect(fallback.Collator.supportedLocalesOf(["zz-ZZ", "xx"])).toEqual([]);

  const root = new fallback.Collator(["zz-ZZ", "xx"]);
  expect(root.resolvedOptions().locale).toBe("und");
  expect(root.compare("ä", "z")).toBe(-1);
  expect(calls.at(-1)?.[0]).toBe("und");

  const control = new fallback.Collator("sv");
  expect(control.resolvedOptions()).toMatchObject({ locale: "sv", numeric: false, caseFirst: "false" });
  expect(control.compare("ä", "z")).toBe(1);
  expect(calls.at(-1)?.slice(1, 4)).toEqual(["variant", undefined, undefined]);
});
