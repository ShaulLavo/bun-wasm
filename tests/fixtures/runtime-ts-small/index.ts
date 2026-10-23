import { Cookie, CookieMap, JSON5, TOML, YAML } from "bun";

const cookie = new Cookie("typed", "读", { sameSite: "strict", maxAge: 10 });
console.log(cookie.toString(), cookie.isExpired());
const map = new CookieMap("first=1; second=2");
map.set(cookie);
console.log(JSON.stringify(Array.from(map)), JSON.stringify(Array.from(map.keys())), JSON.stringify(Array.from(map.values())));
map.delete("first");
console.log(map.get("first"), map.has("typed"), map.toSetCookieHeaders().length);
const parsed = YAML.parse("root: &root\n  value: yes\ncopy: *root\n");
console.log(parsed.root === parsed.copy, parsed.root.value);
console.log(JSON5.stringify({ value: Infinity, text: "quote'" }));
console.log(TOML.stringify({ values: [1, 2], table: { enabled: true } }).trim());
const graphemes = new Intl.Segmenter("en-US").segment("A\u0301👩‍👩‍👧‍👦");
console.log(Array.from(graphemes, entry => entry.segment).join("|"));
console.log(new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(1234.5));
console.log(new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeZone: "UTC" }).format(new Date("2024-02-29T12:34:56Z")));
console.log(new Intl.PluralRules("en-US", { type: "ordinal" }).select(23));
