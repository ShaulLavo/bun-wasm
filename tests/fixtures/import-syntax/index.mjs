import * as star from "./lib/star.mjs";
import { value } from "./lib/value.mjs";
import { other } from "./lib/reexport.mjs";
import { value as escaped } from "./lib/\u0076alue.mjs";
const π = "UTF-8";
import "./lib/side-effect.mjs";
const a = { import(x) { return x; } };
class Filter { static import(x) { return x; } }
console.log("methods", Filter.import(42), a.import(43), a?.import(44), a.import?.(45));
console.log("properties", { import: 1 }.import, { "import": 2 }["import"]);
const text = "import(never)";
const template = `import(never) ${a.import(46)}`;
/* import("never") */
// import("never")
console.log("literals", text, /import\(never\)/.test(text), template);
if (true) /import\(never\)/.test(text) && console.log("regex statement", true);
const computed = "./lib/" + "value.mjs";
console.log("imports", value, other, (await import("./lib/value.mjs")).value, (await import(computed)).value);
console.log("template import", `value ${(await import(`./lib/${"value"}.mjs`)).value}`);
console.log("nested template", `outer ${`inner ${(await import(computed)).value}`}`);
const attrs = { with: { type: "json" } };
console.log("attributes", (await import("./lib/data.json", { with: { type: "json" } })).default.answer, (await import("./lib/data.json", attrs)).default.answer);
console.log("meta", import.meta.path, import.meta.main);
console.log("cjs", await require("./lib/dynamic.cjs")());
const sync = require("./lib/sync-importer.mjs");
console.log("esm as cjs", (await sync.load("./value.mjs")).value, sync.nested());
let effects = 0;
console.log("attribute effects", (await import("./lib/data.json", (++effects, attrs))).default.answer, effects);
console.log("comment import", (await import /* retained gap */ (computed,)).value);
const arrow = async (load = () => import(computed)) => (await load()).value;
console.log("arrow", await arrow());

console.log("escaped", escaped, π);
console.log("star", star.value, star.namespace.value);
