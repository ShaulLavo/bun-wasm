const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: bun scripts/transpile-runtime.ts <source.ts> <output.js>");

const transpiler = new Bun.Transpiler({
  loader: "ts",
  target: "bun",
  treeShaking: false,
  deadCodeElimination: false,
});
// Bun prints modules as implicitly strict; these factories run as scripts.
await Bun.write(destination, '"use strict";\n' + transpiler.transformSync(await Bun.file(source).text()));
