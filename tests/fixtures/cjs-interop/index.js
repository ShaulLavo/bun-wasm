const path = require("path");
const lib = require("./lib/cjs-lib");
const again = require("./lib/cjs-lib.js");
console.log("require:", lib.greet("cjs"), lib === again);
console.log("exports shorthand:", require("./lib/exports-short").value);
console.log("module.exports function:", typeof require("./lib/fn-export"), require("./lib/fn-export")());
console.log("__filename:", __filename);
console.log("__dirname:", __dirname);
console.log("require.resolve:", path.relative(__dirname, require.resolve("./lib/cjs-lib")));
console.log("json require:", require("./lib/data.json").answer);
console.log("cache has lib:", Object.keys(require.cache).some((k) => k.endsWith("cjs-lib.js")));
console.log("module.id:", module.id, "main:", require.main === module);
const circ = require("./lib/circular-a");
console.log("circular:", circ.done, circ.sawB);
const esm = require("./lib/esm.mjs");
console.log("require(esm):", esm.default, esm.named);
try {
  require("./nope");
} catch (err) {
  console.log("missing require:", err.code || err.name);
}
import("./lib/importer.mjs").then((m) => {
  console.log("esm importing cjs:", m.result);
});
