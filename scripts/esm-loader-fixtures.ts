// Regenerates tests/fixtures/esm-loader/*/records.json (each module as a
// registration record from bunwasm-transpiler) and expected.txt (Node's output
// for the same modules). Usage, after building the transpiler example:
//   cargo build -p bunwasm-transpiler --example transpile
//   bun scripts/esm-loader-fixtures.ts "$CARGO_TARGET_DIR/debug/examples/transpile"
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureCases, fixturesDir, type Records } from "./esm-loader-harness";

const usage = "usage: esm-loader-fixtures.ts <transpile example binary>";
const transpile: string = process.argv[2] ?? (() => { throw new Error(usage); })();

function register(file: string): string {
  return execFileSync(transpile, ["--register", file], { encoding: "utf8" });
}

function records(dir: string): Records {
  const out: Records = { modules: {}, cjs: {} };
  for (const file of readdirSync(dir).sort()) {
    const path = join(dir, file);
    if (file.endsWith(".mjs")) out.modules[`/${file}`] = register(path);
    if (!file.endsWith(".cjs")) continue;
    out.cjs[`/${file}`] = readFileSync(path, "utf8");
  }
  return out;
}

const runner = 'import(process.argv[1]).then(undefined, error => console.log("<rejected>", error && error.message))';
for (const name of fixtureCases()) {
  const dir = join(fixturesDir, name);
  writeFileSync(join(dir, "records.json"), JSON.stringify(records(dir), null, 1) + "\n");
  const expected = execFileSync("node", ["-e", runner, join(dir, "main.mjs")], { encoding: "utf8" });
  writeFileSync(join(dir, "expected.txt"), expected);
  console.log(`${name}: ${expected.split("\n").length - 1} lines`);
}
