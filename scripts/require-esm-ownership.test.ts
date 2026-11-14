import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-require-ownership-"));
const show = "function show(error) { console.log(`${error.constructor.name}: ${error.message}`); }\n";
const cases = [
  {
    name: "immediate",
    files: {
      "parent.mjs": "import './absent.mjs';\n",
      "throws.mjs": "throw new Error('body failure');\n",
      "index.ts": `${show}
try { require('./parent.mjs'); } catch (error) { show(error); }
try { require('./throws.mjs'); } catch (error) { show(error); }
console.log('done');
`,
    },
    expected: "Error: Cannot find module './absent.mjs' from '/parent.mjs'\nError: body failure\ndone\n",
  },
  {
    name: "delayed",
    files: {
      "tla-throws.mjs": "await new Promise(resolve => setTimeout(resolve, 0)); throw new Error('delayed failure');\n",
      "index.ts": `${show}
async function main() {
  try { require('./tla-throws.mjs'); } catch (error) { show(error); }
  await new Promise(resolve => setTimeout(resolve, 20));
  console.log('done');
}
main().catch(error => { throw error; });
`,
    },
    expected: "TypeError: require() async module \"/tla-throws.mjs\" is unsupported. use \"await import()\" instead.\ndone\n",
  },
  {
    name: "pending-adoption",
    files: {
      "then.mjs": "export function then(resolve) { resolve(globalThis.q); }\n",
      "index.ts": `${show}
globalThis.q = new Promise((resolve, reject) => { globalThis.rejectQ = reject; });
try { require('./then.mjs'); } catch (error) { show(error); }
setTimeout(() => rejectQ(new Error('late adoption')), 0);
setTimeout(() => console.log('done'), 20);
`,
    },
    expected: "TypeError: require() async module \"/then.mjs\" is unsupported. use \"await import()\" instead.\ndone\n",
  },
  {
    name: "settled-adoption",
    files: {
      "then.mjs": "export function then(resolve) { resolve(globalThis.q); }\n",
      "index.ts": `${show}
globalThis.adoptionError = new Error('settled adoption');
globalThis.q = Promise.reject(adoptionError);
try { require('./then.mjs'); } catch (error) { show(error); }
setTimeout(() => console.log('done'), 20);
`,
    },
    expected: "Error: settled adoption\ndone\n",
  },
  {
    name: "inspection",
    files: {
      "then.mjs": "export function then(resolve) { resolve(globalThis.q); }\n",
      "index.ts": `${show}
const { inspect } = require('node:util');
globalThis.adoptionError = new Error('inspected adoption');
globalThis.q = new Promise((resolve, reject) => { globalThis.rejectQ = reject; });
try { require('./then.mjs'); } catch (error) { show(error); }
setTimeout(() => {
  rejectQ(adoptionError);
  setTimeout(() => {
    console.log('peek same', Bun.peek(q) === adoptionError);
    console.log('inspect rejected', inspect(q).includes('<rejected>'));
    console.log('done');
  }, 0);
}, 0);
`,
    },
    expected: "TypeError: require() async module \"/then.mjs\" is unsupported. use \"await import()\" instead.\npeek same true\ninspect rejected true\ndone\n",
  },
] as const;

type Target = { engine: string; core: string; tier?: string };
function targets(): Target[] {
  const selected = process.env.INSTALL_ENGINES?.split(",") ?? ["quickjs", "jsc"];
  const result: Target[] = [];
  for (const engine of ["quickjs", "jsc"]) {
    if (selected.includes(engine)) result.push({ engine, core: join(root, engine === "quickjs" ? "dist/bun.wasm" : `dist/bun-${engine}.wasm`) });
  }
  const spiderMonkey = process.env.SPIDERMONKEY_WASM;
  if (spiderMonkey) {
    for (const tier of ["interp", "pbl"]) result.push({ engine: "spidermonkey", core: spiderMonkey, tier });
  }
  if (process.env.HERMES_WASM) result.push({ engine: "hermes", core: process.env.HERMES_WASM });
  return result;
}

function run(target: Target, directory: string) {
  const launcher = process.env.BUN_WASM_LAUNCHER ?? join(root, "target/release/bun-wasm");
  const shell = process.env.BUN_WASM_SHELL ?? join(root, "dist/bash-web-shell.wasm");
  const envUtility = process.env.BUN_WASM_ENV_UTILITY ?? join(root, "dist/bash-web-env.wasm");
  const args = [
    "--wasm", target.core, "--engine", `${target.engine}=${target.core}`,
    "--shell", shell, "--env-utility", envUtility,
    "--dir", `${directory}::/`, "--env", "PWD=/", "--env", "HOME=/",
  ];
  if (target.tier) args.push("--env", `BUN_WASM_SPIDERMONKEY_TIER=${target.tier}`);
  return spawnSync(launcher, args.concat(["--", "run", "/index.ts"]), {
    cwd: directory,
    env: { ...process.env, ...(target.tier ? { BUN_WASM_SPIDERMONKEY_TIER: target.tier } : {}) },
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function runCase(target: Target, test: (typeof cases)[number]): boolean {
  const directory = join(scratch, `${target.engine}-${target.tier ?? "default"}-${test.name}`);
  mkdirSync(directory);
  for (const [name, source] of Object.entries(test.files)) writeFileSync(join(directory, name), source);
  const result = run(target, directory);
  const label = `${target.engine}${target.tier ? `-${target.tier}` : ""}/${test.name}`;
  const pass = result.status === 0 && result.stdout === test.expected && result.stderr === "";
  console.log(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (pass) return true;
  console.log(JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, expected: test.expected }, null, 2));
  return false;
}

function runCases(): number {
  let failures = 0;
  for (const target of targets()) {
    for (const test of cases) {
      if (!runCase(target, test)) failures += 1;
    }
  }
  return failures;
}

try {
  assert.equal(runCases(), 0, "require ownership probes failed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
