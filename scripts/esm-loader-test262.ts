// Runs test262's module-code tests through the registration transform and
// esm_loader.ts on a script engine. Development tool, not a CI check: it needs
// a test262 checkout and the transpiler example binary.
//   cargo build -p bunwasm-transpiler --example transpile
//   bun scripts/esm-loader-test262.ts <test262 dir> <transpile binary> [engine command…]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loaderSource } from "./esm-loader-harness";

type Meta = { flags: string[]; includes: string[]; features: string[]; negative: string | null; parseNegative: boolean };
type Outcome = "pass" | "fail" | "transform" | "skip";

const [test262, transpile, ...engineArgs] = process.argv.slice(2);
if (!test262 || !transpile) throw new Error("usage: esm-loader-test262.ts <test262 dir> <transpile binary> [engine…]");
const engine = engineArgs.length > 0 ? engineArgs : ["bun"];
// Proposals the runtime's module host doesn't implement.
const unsupported = new Set(["import-attributes", "json-modules", "source-phase-imports", "import-defer", "import-text", "import-bytes"]);

function frontmatter(source: string): Meta {
  const yaml = source.match(/\/\*---([\s\S]*?)---\*\//)?.[1] ?? "";
  const list = (key: string) => (yaml.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`))?.[1] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const negative = yaml.match(/negative:\s*\n\s*phase:\s*(\w+)\s*\n\s*type:\s*(\w+)/);
  return { flags: list("flags"), includes: list("includes"), features: list("features"), negative: negative?.[2] ?? null, parseNegative: negative?.[1] === "parse" };
}

// The test and every fixture it can reach, statically or through import().
function moduleGraph(entry: string): Record<string, string> {
  const records: Record<string, string> = {};
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (records[file] !== undefined) continue;
    records[file] = execFileSync(transpile!, ["--register", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const requests: string[] = JSON.parse(records[file]!.match(/^\(\{r:(\[[^\]]*\])/)?.[1] ?? "[]");
    const dynamic = Array.from(readFileSync(file, "utf8").matchAll(/['"](\.\/[^'"]+_FIXTURE\.js)['"]/g), match => match[1]!);
    for (const specifier of requests.concat(dynamic)) {
      const path = resolve(dirname(file), specifier);
      if (existsSync(path)) pending.push(path);
    }
  }
  return records;
}

const natives = `const native = {
  resolve(specifier, referrer) {
    const parts = [];
    for (const part of (specifier.startsWith("/") ? specifier : referrer.slice(0, referrer.lastIndexOf("/") + 1) + specifier).split("/")) {
      if (part === "..") parts.pop(); else if (part !== "" && part !== ".") parts.push(part);
    }
    const name = "/" + parts.join("/");
    if (!(name in records)) throw new TypeError("Cannot find module " + specifier);
    return name;
  },
  load: name => ({ record: records[name] }),
  initMeta(name, meta) { meta.url = "file://" + name; },
};`;

function script(file: string, meta: Meta, records: Record<string, string>, loader: string): string {
  const isAsync = meta.flags.includes("async");
  const harness = ["assert.js", "sta.js"].concat(isAsync ? ["doneprintHandle.js"] : [], meta.includes);
  const entries = Object.entries(records).map(([name, code]) => `${JSON.stringify(name)}: ${code}`);
  return `if (typeof print !== "function") globalThis.print = (...args) => console.log(...args);
${harness.map(name => readFileSync(join(test262!, "harness", name), "utf8")).join("\n")}
const records = {${entries.join(",\n")}};
${natives}
const negative = ${JSON.stringify(meta.negative)};
(${loader})(native).importModule(${JSON.stringify(file)}, "").then(
  () => print(negative ? "Test262:FAIL expected " + negative : ${isAsync} ? "" : "Test262:PASS"),
  error => print(negative && error && error.constructor.name === negative ? "Test262:PASS" : "Test262:FAIL " + error));`;
}

function runTest(file: string, scratch: string, loader: string): [Outcome, string] {
  const meta = frontmatter(readFileSync(file, "utf8"));
  if (!meta.flags.includes("module") || meta.parseNegative || meta.features.some(f => unsupported.has(f))) return ["skip", ""];
  let records: Record<string, string>;
  try {
    records = moduleGraph(file);
  } catch (error) {
    return ["transform", String((error as { stderr?: string }).stderr ?? error).split("\n")[0]!];
  }
  const path = join(scratch, "test.js");
  writeFileSync(path, script(file, meta, records, loader));
  const run = spawnSync(engine[0]!, engine.slice(1).concat(path), { encoding: "utf8", timeout: 20_000 });
  const output = run.stdout + run.stderr;
  const passed = /Test262:(PASS|AsyncTestComplete)/.test(output) && !/Test262:(FAIL|AsyncTestFailure)/.test(output);
  return [passed ? "pass" : "fail", output.trim().split("\n").at(-1) ?? ""];
}

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return path.endsWith(".js") && !path.includes("_FIXTURE") ? [path] : [];
  });
}

const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "bun-wasm-esm-test262-"));
const counts: Record<Outcome, number> = { pass: 0, fail: 0, transform: 0, skip: 0 };
try {
  const loader = loaderSource();
  for (const file of testFiles(join(test262, "test/language/module-code")).sort()) {
    const [outcome, detail] = runTest(file, scratch, loader);
    counts[outcome] += 1;
    if (outcome === "fail" || outcome === "transform") console.log(`${outcome.toUpperCase()} ${file.slice(test262.length + 1)} :: ${detail.slice(0, 200)}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`pass ${counts.pass} fail ${counts.fail} transform-error ${counts.transform} skipped ${counts.skip}`);
