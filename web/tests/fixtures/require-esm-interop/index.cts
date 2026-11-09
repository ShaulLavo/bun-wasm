async function run() {
  const options = { entrypoints: ["/public.mts"], target: "bun", format: "cjs", external: ["*"] };
  const before = await Bun.build(options);
  if (!before.success) throw new Error("public build before require failed");
  const original = await before.outputs[0].text();
  const first = require("./parent.mts");
  const second = require("./parent.mts");
  console.log(first === second, typeof first.default, typeof first.run);
  first.run();
  const child = require("./child.mts");
  console.log(child === require("./child.mts"), child.count, child.default === first.default);
  const after = await Bun.build(options);
  if (!after.success || original !== await after.outputs[0].text()) throw new Error("public bundler output changed");
  if (!original.includes("__toESM(require(")) throw new Error("public import control did not exercise interop");
  console.log("public bundler unchanged");
}
run();
