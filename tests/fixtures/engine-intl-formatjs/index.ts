const instant = new Date("2024-02-29T00:00:00Z");
const hostUsesNativeIntl = process.env.BUNWASM_TEST_HOST === "node";
if (hostUsesNativeIntl === (Intl.NumberFormat.polyfilled === true)) throw new Error("Unexpected Intl implementation");
console.log("implementation ok");
for (const locale of ["en-US", "de-DE", "he-IL"]) {
  console.log(locale, JSON.stringify({
    number: new Intl.NumberFormat(locale).format(1234567.5),
    date: new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }).format(instant),
    plural: new Intl.PluralRules(locale).select(2),
  }));
}

const parts = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).formatToParts(1234567.89);
console.log("parts", parts.map(part => part.type).join(","));
console.log("supported", Intl.NumberFormat.supportedLocalesOf(["en-US", "de-DE"]).join(","));
console.log("collation", new Intl.Collator("en").compare("ä", "z"), new Intl.Collator("sv").compare("ä", "z"));
console.log("collationOptions", new Intl.Collator("en", { numeric: true }).compare("item2", "item10"),
  new Intl.Collator("en", { sensitivity: "base" }).compare("a", "ä"));
console.log("collatorPunctuation", new Intl.Collator("en", { ignorePunctuation: true }).compare("a-b", "ab"),
  new Intl.Collator("en", { ignorePunctuation: false }).compare("a-b", "ab"));
const numericExtension = new Intl.Collator("en-u-kn");
const upperExtension = new Intl.Collator("en-u-kf-upper");
console.log("collatorExtensions", numericExtension.compare("item2", "item10"), numericExtension.resolvedOptions().numeric,
  upperExtension.compare("A", "a"), upperExtension.resolvedOptions().caseFirst);
console.log("collatorExtensionOverrides", new Intl.Collator("en-u-kn", { numeric: false }).compare("item2", "item10"),
  new Intl.Collator("en-u-kn", { numeric: false }).resolvedOptions().numeric,
  new Intl.Collator("en-u-kf-upper", { caseFirst: "false" }).compare("A", "a"),
  new Intl.Collator("en-u-kf-upper", { caseFirst: "false" }).resolvedOptions().caseFirst);
const negotiated = new Intl.Collator(["zz-ZZ", "sv"]);
console.log("collatorNegotiation", negotiated.compare("ä", "z"), negotiated.resolvedOptions().locale,
  JSON.stringify(Intl.Collator.supportedLocalesOf(["zz-ZZ", "xx"])));
console.log("timezone", new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Jerusalem",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
}).format(new Date("2024-07-01T00:00:00Z")));
console.log("prototype", (1234.5).toLocaleString("de-DE"), instant.toLocaleDateString("de-DE", { timeZone: "UTC" }));
console.log("list", new Intl.ListFormat("de-DE").format(["rot", "grün", "blau"]));
console.log("relative", new Intl.RelativeTimeFormat("de-DE", { numeric: "auto" }).format(-1, "day"));
console.log("segment", Array.from(new Intl.Segmenter("de-DE", { granularity: "word" }).segment("Das ist gut!"),
  part => `${part.segment}:${part.isWordLike === true}`).join("|"));
console.log("canonical", Intl.getCanonicalLocales(["en-us", "de-de"]).join(","));
console.log("values", Intl.supportedValuesOf("timeZone").includes("Asia/Jerusalem"), Intl.supportedValuesOf("currency").includes("EUR"));

function errorName(run: () => unknown): string {
  try {
    run();
    return "no error";
  } catch (error) {
    if (error instanceof Error) return error.name;
    throw error;
  }
}
console.log("errors", errorName(() => new Intl.NumberFormat("en", { style: "currency" })),
  errorName(() => new Intl.DateTimeFormat("en", { timeZone: "Not/AZone" })),
  errorName(() => new Intl.Collator("not_a_locale")));
