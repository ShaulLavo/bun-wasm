import { format, formatWithOptions, inspect, isDeepStrictEqual, parseEnv, promisify, stripVTControlCharacters } from "node:util";
import cases from "./cases.json" with { type: "json" };

for (const control of cases) {
  const actual = parseEnv(control.source);
  if (!isDeepStrictEqual(Object.entries(actual).sort(), Object.entries(control.expected).sort())) throw new Error(`parseEnv: ${control.name}`);
  if (Object.hasOwn(control.expected, "__proto__") && !Object.hasOwn(actual, "__proto__")) throw new Error("parseEnv lost own __proto__ key");
}
for (const method of [format, formatWithOptions, inspect, promisify, stripVTControlCharacters]) {
  if (typeof method !== "function") throw new Error("Missing published Vite utility import");
}
console.log("parseEnv import and parser controls passed");
