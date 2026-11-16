import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = join(import.meta.dir, "scenarios");
const header = 'import { test, describe, beforeAll, afterAll, beforeEach, afterEach, expect } from "bun:test";\n';
const setup = header + `console.log("preload import");
beforeAll(function () { if (this !== undefined) throw new Error("before receiver"); console.log("before"); });
afterAll(function () { if (this !== undefined) throw new Error("after receiver"); console.log("after"); });
beforeEach(function () { if (this !== undefined) throw new Error("each receiver"); console.log("each before"); });
afterEach(function () { if (this !== undefined) throw new Error("each receiver"); console.log("each after"); });\n`;
const file = (name: string, body = `console.log("body ${name}")`, method = "test") =>
  header + `console.log("import ${name}"); ${method}("${name}", () => { ${body}; });\n`;
const each = (name: string) => ["each before", `body ${name}`, "each after"];
const prefix = ["preload import", "import a", "before"];
const normal = prefix.concat(each("a"), ["import b"], each("b"), ["after"]);

interface Scenario {
  name: string;
  setup: string;
  a: string;
  b: string;
  args: string[];
  lines: string[];
  pass: number;
  fail: number;
  exit: number;
  snapshot: boolean;
  // Replaces the pass/fail summary check: a filter that matches nothing prints only this error.
  summary?: RegExp;
}

function scenario(name: string, values: Partial<Omit<Scenario, "name">>): Scenario {
  return { name, setup, a: file("a"), b: file("b"), args: [], lines: normal, pass: 2, fail: 0, exit: 0, snapshot: false, ...values };
}

const guard = `
let reads = 0, callbacks = 0;
const options = { get timeout() { reads++; return 1; } };
const callback = () => { callbacks++; };
const calls = [() => test(), () => test("bad", callback, options), () => test.skip("bad", callback, options),
  () => test.todo("bad", callback, options), () => test.only("bad", callback, options), () => test.failing("bad", callback, options),
  () => test.concurrent("bad", callback, options), () => test.serial("bad", callback, options),
  () => describe("bad", callback), () => describe.skip("bad", callback), () => describe.todo("bad", callback),
  () => describe.only("bad", callback), () => describe.concurrent("bad", callback), () => describe.serial("bad", callback),
  () => describe(callback), () => test.each([])("bad", callback), () => describe.each([])("bad", callback),
  () => test.each([1])("bad", callback), () => describe.each([1])("bad", callback)];
for (const call of calls) {
  let rejected = false;
  try { call(); } catch (error) { rejected = String(error).includes("during preload."); }
  if (!rejected) throw new Error("preload registration accepted");
}
console.log("guarded", reads, callbacks);\n`;

const cases = [
  scenario("filter-first", { args: ["-t", "b"], lines: prefix.concat(["import b"], each("b"), ["after"]), pass: 1 }),
  scenario("filter-none", { args: ["-t", "missing"], lines: prefix.concat(["import b", "after"]), exit: 1,
    summary: /error: regex "missing" matched 0 tests\. Searched 2 files \(skipping 2 tests\)/ }),
  scenario("only-none", { args: ["--only"], lines: prefix.concat(["import b", "after"]), pass: 0 }),
  scenario("all-skip", { a: file("a", 'console.log("must not run")', "test.skip"), b: file("b", 'console.log("must not run")', "test.skip"),
    lines: prefix.concat(["import b", "after"]), pass: 0 }),
  scenario("all-empty", { a: 'console.log("import a");\n', b: 'console.log("import b");\n', lines: prefix.concat(["import b", "after"]), pass: 0 }),
  scenario("todo-run", { args: ["--todo"], a: file("a", 'console.log("body a")', "test.todo"), b: file("b", 'console.log("body b")', "test.todo"), pass: 0, fail: 2, exit: 1 }),
  scenario("first-import-fails", { a: 'console.log("import a"); throw new Error("first import failed");\n',
    lines: prefix.concat(["import b"], each("b"), ["after"]), pass: 1, fail: 1, exit: 1 }),
  scenario("last-import-fails", { b: 'console.log("import b"); throw new Error("last import failed");\n',
    lines: prefix.concat(each("a"), ["import b", "after"]), pass: 1, fail: 1, exit: 1 }),
  scenario("last-before-fails", { b: file("b") + 'beforeAll(() => { throw new Error("local setup failed"); });\n',
    lines: prefix.concat(each("a"), ["import b", "after"]), pass: 1, fail: 1, exit: 1 }),
  scenario("last-filtered", { args: ["-t", "a"], lines: prefix.concat(each("a"), ["import b", "after"]), pass: 1 }),
  scenario("stopped-global-setup", { setup: setup.replace('console.log("before");', 'console.log("before"); throw new Error("global setup failed");'),
    lines: prefix.concat(["import b", "after"]), pass: 0, fail: 1, exit: 1 }),
  scenario("stopped-preload-import", { setup: setup + 'await Promise.resolve(); throw new Error("preload import failed");\n',
    lines: ["preload import"], pass: 0, fail: 1, exit: 1 }),
  scenario("after-failure-flush", { setup: setup.replace('console.log("after");', 'console.log("after"); throw new Error("global teardown failed");')
      + 'afterAll(() => console.log("must not tear down again"));\n',
    b: file("b", 'console.log("body b"); expect("queued final snapshot").toMatchSnapshot()'), args: ["-u"], fail: 1, exit: 1, snapshot: true }),
  scenario("registration-guards", { setup: setup + guard, lines: ["preload import", "guarded 0 0"].concat(normal.slice(1)) }),
  scenario("body-failure-finalizes", { b: file("b", 'console.log("body b"); throw new Error("body failed")'), pass: 1, fail: 1, exit: 1 }),
  scenario("bail-last", { b: file("b", 'console.log("body b"); throw new Error("last bail body failed")'), args: ["--bail"],
    lines: normal.slice(0, -1), pass: 1, fail: 1, exit: 1 }),
  scenario("bail", { a: file("a", 'console.log("body a"); throw new Error("bail body failed")'), args: ["--bail"],
    lines: prefix.concat(each("a")), pass: 0, fail: 1, exit: 1 }),
];

function assertSummary(item: Scenario, stderr: string) {
  if (item.summary) return assert.match(stderr, item.summary, item.name);
  // Like native Bun, a bailed run prints no pass/fail summary.
  if (item.name.startsWith("bail")) return assert.match(stderr, /Bailed out after 1 failure/);
  assert.match(stderr, new RegExp(` ${item.pass} pass\\n`), item.name);
  assert.match(stderr, new RegExp(` ${item.fail} fail\\n`), item.name);
}

function runCase(item: Scenario) {
  const work = join(directory, item.name);
  mkdirSync(work, { recursive: true });
  for (const [name, text] of [["setup.ts", item.setup], ["a.test.ts", item.a], ["b.test.ts", item.b]]) writeFileSync(join(work, name), text);
  const args = [process.execPath, "test", "--preload", "./setup.ts"].concat(item.args, ["./a.test.ts", "./b.test.ts"]);
  const child = Bun.spawnSync(args, { cwd: work, stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENT: "0", NO_COLOR: "1" } });
  const stderr = child.stderr.toString();
  const lines = child.stdout.toString().trim().split("\n").filter(line => !line.startsWith("bun test "));
  assert.equal(child.exitCode, item.exit, `${item.name}\n${stderr}`);
  assert.deepEqual(lines, item.lines, item.name);
  assertSummary(item, stderr);
  if (item.snapshot) assert.match(readFileSync(join(work, "__snapshots__/b.test.ts.snap"), "utf8"), /queued final snapshot/);
  console.log(`${item.name}: pass`);
}

try {
  for (const item of cases) runCase(item);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
