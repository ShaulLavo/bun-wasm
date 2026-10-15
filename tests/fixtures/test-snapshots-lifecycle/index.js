import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
function run(name, env, args = []) {
  const result = Bun.spawnSync([process.execPath, "test", `./${name}/case.test.js`].concat(args), { env: Object.assign({ AGENT: "0" }, env) });
  return { code: result.exitCode, stderr: result.stderr.toString() };
}
function make(name, source) {
  mkdirSync(name, { recursive: true });
  writeFileSync(`${name}/case.test.js`, source);
}
const source = `import { test, expect } from "bun:test";
test("saved", () => {
  expect({ n: 1 }).toMatchInlineSnapshot();
  expect({ id: 42 }).toMatchInlineSnapshot({ id: expect.any(Number) });
  expect("file one").toMatchSnapshot();
});
`;
make("ci", source);
const ci = run("ci", { CI: "true" });
console.log("missing CI", ci.code, ci.stderr.includes("creation is disabled in CI"), read("ci/case.test.js") === source);
console.log("missing CI contents", !existsSync("ci/__snapshots__/case.test.js.snap") || !read("ci/__snapshots__/case.test.js.snap").includes("exports["));

make("saved", source);
const first = run("saved", { CI: "false", GITHUB_ACTIONS: "true" });
const createdSource = read("saved/case.test.js");
const createdFile = read("saved/__snapshots__/case.test.js.snap");
console.log("create", first.code, createdSource.includes('"n": 1,'), createdSource.includes('"id": Any<Number>,'), createdFile.includes('exports[`saved 3`] = `"file one"`;'));
console.log("existing CI", run("saved", { CI: "true" }).code);
writeFileSync("saved/case.test.js", createdSource.replace("n: 1", "n: 2").replace("file one", "file two"));
const mismatchSource = read("saved/case.test.js");
console.log("mismatch", run("saved", { CI: "false" }).code, read("saved/case.test.js") === mismatchSource, read("saved/__snapshots__/case.test.js.snap") === createdFile);
console.log("update short", run("saved", { CI: "true" }, ["-u"]).code, read("saved/case.test.js").includes('"n": 2,'), read("saved/__snapshots__/case.test.js.snap").includes('`"file two"`'));
console.log("updated CI", run("saved", { CI: "true" }).code);

make("vendor", source);
const vendor = run("vendor", { GITHUB_ACTIONS: "true" });
console.log("vendor CI", vendor.code, vendor.stderr.includes("creation is disabled in CI"));
console.log("update long", run("vendor", { GITHUB_ACTIONS: "true" }, ["--update-snapshots"]).code, read("vendor/case.test.js").includes('"n": 1,'));
