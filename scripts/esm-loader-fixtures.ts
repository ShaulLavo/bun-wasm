// Regenerates tests/fixtures/esm-loader/*/records.json (each module as a
// registration record from bunwasm-transpiler) and expected.txt (Node's output
// for the same modules). Usage, after building the transpiler example:
//   cargo build -p bunwasm-transpiler --example transpile
//   bun scripts/esm-loader-fixtures.ts "$CARGO_TARGET_DIR/debug/examples/transpile"
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fixtureCases, fixturesDir, type Records } from "./esm-loader-harness";

const usage = "usage: esm-loader-fixtures.ts <transpile example binary>";
const transpile: string = process.argv[2] ?? (() => { throw new Error(usage); })();

const isPlainIdentifier = (key: string) => /^[\p{L}\p{N}_$]+$/u.test(key);

// The runtime's wrapper for a CommonJS module (modules.rs `wrapper_source`).
function wrapperSource(keys: string[]): string {
  let source = "const m = import.meta.m.value; export default import.meta.m.default;\n";
  const exports: string[] = [];
  keys.forEach((key, i) => {
    if (key === "default" || key === "__esModule" || !isPlainIdentifier(key)) return;
    source += `const e${i} = m[${JSON.stringify(key)}];\n`;
    exports.push(`e${i} as ${JSON.stringify(key)}`);
  });
  if (exports.length > 0) source += `export { ${exports.join(", ")} };\n`;
  return source;
}

function register(file: string): string {
  return execFileSync(transpile, ["--register", file], { encoding: "utf8" });
}

function records(dir: string, scratch: string): Records {
  const out: Records = { modules: {}, cjs: {} };
  const require = createRequire(join(dir, "index.js"));
  for (const file of readdirSync(dir).sort()) {
    const path = join(dir, file);
    if (file.endsWith(".mjs")) out.modules[`/${file}`] = register(path);
    if (!file.endsWith(".cjs")) continue;
    out.cjs[`/${file}`] = readFileSync(path, "utf8");
    const wrapper = join(scratch, `${file}.mjs`);
    writeFileSync(wrapper, wrapperSource(Object.keys(require(path))));
    out.modules[`/${file}`] = register(wrapper);
  }
  return out;
}

const runner = 'import(process.argv[1]).then(undefined, error => console.log("<rejected>", error && error.message))';
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "bun-wasm-esm-fixtures-"));
try {
  for (const name of fixtureCases()) {
    const dir = join(fixturesDir, name);
    writeFileSync(join(dir, "records.json"), JSON.stringify(records(dir, scratch), null, 1) + "\n");
    const expected = execFileSync("node", ["-e", runner, join(dir, "main.mjs")], { encoding: "utf8" });
    writeFileSync(join(dir, "expected.txt"), expected);
    console.log(`${name}: ${expected.split("\n").length - 1} lines`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
