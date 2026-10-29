import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/intl.js", import.meta.url), "utf8");
const nativeIntl = Intl;
type NativeCollatorOptions = NonNullable<ConstructorParameters<typeof Intl.Collator>[1]>;
type CallbackArgs = [string, NativeCollatorOptions["sensitivity"], NativeCollatorOptions["numeric"], NativeCollatorOptions["caseFirst"], NativeCollatorOptions["ignorePunctuation"], NativeCollatorOptions["collation"], string, string];
const nativeControl = process.env.BUNWASM_INTL_NATIVE_CONTROL;

function nativeResult(args: string[]): unknown {
  if (nativeControl === undefined) throw new Error("Missing Intl native control");
  const result = Bun.spawnSync([nativeControl].concat(args));
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

function factoryWithNativeCallback() {
  const calls: CallbackArgs[] = [];
  const context = vm.createContext({});
  const fallback = vm.runInContext(source, context)({ native: {
    collatorResolveLocale(locale: string): string | null {
      if (nativeControl !== undefined) {
        const result = nativeResult(["collatorResolveLocale", locale]);
        if (result === null || typeof result === "string") return result;
        throw new Error("Invalid native locale result");
      }
      if (nativeIntl.Collator.supportedLocalesOf([locale]).length === 0) return null;
      return new nativeIntl.Collator(locale).resolvedOptions().locale;
    },
    collatorCompare(...args: CallbackArgs): number {
      calls.push(args);
      if (nativeControl !== undefined) {
        const result = nativeResult(["collatorCompare"].concat(args.map(value => value === undefined ? "-" : String(value))));
        if (typeof result === "number") return result;
        throw new Error("Invalid native comparison result");
      }
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
  return { fallback, calls, context };
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

test("resolved locales retain supported collation extensions unless an option changes their value", () => {
  const { fallback } = factoryWithNativeCallback();
  const cases: [string, NativeCollatorOptions][] = [
    ["en-u-kn", {}],
    ["en-u-kn", { numeric: true }],
    ["en-u-kn", { numeric: false }],
    ["en-u-kn-false", { numeric: false }],
    ["en-u-kn-false", { numeric: true }],
    ["en-u-kf-upper", {}],
    ["en-u-kf-upper", { caseFirst: "upper" }],
    ["en-u-kf-upper", { caseFirst: "false" }],
    ["de-u-co-phonebk", {}],
    ["de-u-co-phonebk", { collation: "phonebk" }],
    ["de-u-co-phonebk", { collation: "emoji" }],
    ["de-u-co-phonebk-kf-upper-kn", { numeric: false }],
    ["en", { numeric: true, caseFirst: "upper" }],
  ];
  for (const [locale, options] of cases) {
    expect(new fallback.Collator(locale, options).resolvedOptions()).toEqual(new nativeIntl.Collator(locale, options).resolvedOptions());
  }
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

test("generated library formats loaded locales and rejects invalid options", () => {
  const { fallback } = factoryWithNativeCallback();
  expect(new fallback.NumberFormat("de-DE").format(1234.5)).toBe("1.234,5");
  expect(new fallback.PluralRules("he").select(2)).toBe("two");
  expect(new fallback.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem", hour: "numeric", hourCycle: "h23",
  }).format(new Date("2024-07-01T00:00:00Z"))).toBe("03");
  expect(() => new fallback.NumberFormat("en", { style: "currency" })).toThrow();
  expect(() => new fallback.DateTimeFormat("en", { timeZone: "Not/AZone" })).toThrow();
  expect(() => new fallback.Collator("not_a_locale")).toThrow();
  expect(() => new fallback.Collator("en", { sensitivity: "invalid" })).toThrow();
  expect(() => new fallback.Collator("en", { caseFirst: "invalid" })).toThrow();
  expect(() => new fallback.Collator("en", { localeMatcher: "invalid" })).toThrow();
  expect(() => new fallback.Collator("en", { usage: "search" })).toThrow("search usage is not supported");
});

test("generated library runs the engine fixture with production locale wrappers and a native callback control", () => {
  const { context } = factoryWithNativeCallback();
  const output: string[] = [];
  context.process = { env: { BUNWASM_TEST_HOST: "native" } };
  context.console = { log: (...parts: unknown[]) => output.push(parts.join(" ")) };
  const bootstrap = readFileSync(new URL("../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");
  const start = bootstrap.lastIndexOf("  if (installIntlFallback) {");
  const end = bootstrap.indexOf("\n\n  return internal;", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  vm.runInContext(`const installIntlFallback = true;
    function defineHidden(target, values) {
      for (const key of Object.keys(values)) Object.defineProperty(target, key, {
        value: values[key], writable: true, configurable: true,
      });
    }
    ${bootstrap.slice(start, end)}`, context);
  const fixture = new URL("../tests/fixtures/engine-intl-formatjs/", import.meta.url);
  const input = readFileSync(new URL("index.ts", fixture), "utf8");
  vm.runInContext(new Bun.Transpiler({ loader: "ts" }).transformSync(input), context);
  expect(output.join("\n") + "\n").toBe(readFileSync(new URL("expected.txt", fixture), "utf8"));
});
