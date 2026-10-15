// RegExp, JSON, Intl (ICU in wasm, root/en data) and Date in UTC.
const re = /(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/g;
const text = "dates: 2024-01-15, 2025-12-31 and 1999-07-04";
console.log([...text.matchAll(re)].map((m) => `${m.groups!.day}/${m.groups!.month}/${m.groups!.year}`));
console.log("CamelCaseString".replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(), /\p{L}+/u.exec("123 héllo")![0]);
console.log("a,b;c d".split(/[,; ]/), /^[\w.+-]+@\w+\.\w+$/.test("x.y+z@bun.sh"), "aaa".replace(/a/y, "b"));
const obj = { s: "q\"uote", n: [1, 2.5, -3e-7], nested: { t: true, f: null }, u: undefined, d: new Date(0) };
const json = JSON.stringify(obj, null, 2);
console.log(json);
console.log(JSON.parse(json, (k, v) => (typeof v === "number" ? v * 2 : v)).n);
console.log(JSON.stringify(" \ud800"), JSON.stringify({ big: 10n.toString() }));
console.log(new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(1234567.891));
console.log(new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 1, 29))));
console.log(["b", "a", "C", "é"].sort(new Intl.Collator("en").compare), (0.256).toLocaleString("en-US", { style: "percent" }));
console.log(new Date(Date.UTC(2020, 0, 1, 12, 30)).toISOString(), "İ".toLowerCase().length, "ß".toUpperCase());
console.log(new Intl.PluralRules("en-US").select(1), new Intl.PluralRules("en-US", { type: "ordinal" }).select(2));
