import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { browserBuildConfig } from "../../scripts/browser-build";
import { initialJavaScript } from "../../scripts/runtime-size";

test("sandbox loads HTML and CSS editor support only when a matching file opens", async () => {
  const main = resolve(import.meta.dir, "../../sandbox/src/main.ts");
  const { outdir: _outdir, ...config } = browserBuildConfig([main], "unused");
  const result = await Bun.build(config);
  expect(result.success).toBe(true);
  if (!result.metafile) throw new Error("Missing sandbox production graph");
  const outputs = result.metafile.outputs;
  const entry = Object.keys(outputs).find(path => path.endsWith("/main.js"));
  if (!entry) throw new Error("Missing sandbox page entry");
  const initial = initialJavaScript(outputs, [entry]);
  const inputs = initial.flatMap(path => Object.keys(outputs[path]!.inputs));
  expect(inputs.some(path => path.includes("@codemirror/lang-javascript/"))).toBe(true);
  expect(inputs.filter(path => /(?:@codemirror\/lang-|@lezer\/)(?:html|css)\//.test(path))).toEqual([]);
  for (const language of ["html", "css"]) {
    expect(Object.values(outputs).some(output => Object.keys(output.inputs).some(path => path.includes(`@codemirror/lang-${language}/`)))).toBe(true);
  }
});
