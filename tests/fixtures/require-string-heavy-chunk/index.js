// A webpack development chunk: 5.4 MiB, almost all of it string literals passed to eval, so it
// declares few symbols. Loading it must not reserve parser tables in proportion to its bytes,
// which in a 512 MiB wasm32 guest ran Next.js dev servers out of memory.
const fs = require("fs");
const modules = [];
for (let i = 0; i < 700; i++) {
  const body = `var value${i} = ${JSON.stringify("x".repeat(8000))};\nmodule.exports = value${i}.length;`;
  modules.push(`"./m${i}.js": ((module) => { eval(${JSON.stringify(body)}); })`);
}
fs.writeFileSync("chunk.js", `exports.id = "vendor"; exports.modules = {\n${modules.join(",\n")}\n};\n`);
const before = process.memoryUsage().rss;
const chunk = require("./chunk.js");
const growth = process.memoryUsage().rss - before;
const sample = {};
chunk.modules["./m3.js"](sample);
console.log("chunk MiB", (fs.statSync("chunk.js").size / 2 ** 20).toFixed(1), "modules", Object.keys(chunk.modules).length, "sample", sample.exports);
console.log("linear memory growth under 12 MiB", growth < 12 * 2 ** 20);
