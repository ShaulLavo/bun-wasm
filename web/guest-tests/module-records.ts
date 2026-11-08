import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

/**
 * Registration-record controls on the actual browser guest: each case runs with the Node
 * host's module store (native host ES modules) and without one (records, as every browser
 * worker), and must print the same thing in both, which `expected` also pins. The cases are
 * the source review's reproducers (R1 to R9) plus CommonJS order and failure controls.
 */
type Case = { files: Record<string, string>; entry?: string[]; expected: string; status?: number };

const cases: Record<string, Case> = {
  // R1: names of Object.prototype members are own exports.
  "proto exports": {
    files: {
      "main.mjs": "import { __proto__ as p, constructor as c, toString as t } from './dep.mjs'; import * as ns from './dep.mjs'; console.log(p, c, t, Object.keys(ns).join());",
      "dep.mjs": "export const __proto__ = 1, constructor = 2, toString = 3;",
    },
    expected: "1 2 3 __proto__,constructor,toString\n",
  },
  // R1 for CommonJS: a prototype-like own key of `module.exports`.
  "proto commonjs keys": {
    files: {
      "main.mjs": "import lib, * as ns from './lib.cjs'; console.log(Object.keys(ns).join(), ns.plain, Object.hasOwn(lib, '__proto__'));",
      "lib.cjs": "module.exports = JSON.parse('{\"__proto__\": 5, \"constructor\": 6, \"plain\": 7}');",
    },
    expected: "__proto__,constructor,default,plain 7 true\n",
  },
  // R2: two exports of one local reached through two stars are one binding.
  "alias diamond": {
    files: {
      "main.mjs": "import { x } from './hub.mjs'; import * as hub from './hub.mjs'; console.log(x, Object.keys(hub).join());",
      "origin.mjs": "const local = 1, other = 1; export { local as a, local as b, other as c };",
      "one.mjs": "export { a as x, a as y } from './origin.mjs';",
      "two.mjs": "export { b as x, c as y } from './origin.mjs';",
      "hub.mjs": "export * from './one.mjs'; export * from './two.mjs';",
    },
    expected: "1 x\n",
  },
  // R3: the record's identifiers never capture the module's own.
  "generated name collisions": {
    files: {
      "main.mjs": "import { x } from './dep.mjs'; const __bunwasm_m = 42, __bunwasm_ns0_0 = 'n', __bunwasm_i = 'i'; globalThis.__bunwasm_cjs__ = 7; globalThis.arguments = 'g'; const __bunwasm_arguments = 'a';\nfor await (const v of [x]) console.log(__bunwasm_m, __bunwasm_ns0_0, __bunwasm_i, v, typeof __bunwasm_cjs__, arguments, __bunwasm_arguments, import.meta.path);",
      "dep.mjs": "export const x = 'x';",
    },
    expected: "42 n i x number g a /main.mjs\n",
  },
  // R4: module-level new.target is an early error, before any body runs; nested uses stay.
  "new.target early errors": {
    files: {
      "main.mjs": "for (const file of ['./direct.mjs', './arrow.mjs', './nested.mjs']) { try { const m = await import(file); console.log(file, m.value); } catch (error) { console.log(file, error.name); } }",
      "direct.mjs": "console.log('direct ran'); console.log(new.target);",
      "arrow.mjs": "console.log('arrow ran'); export const value = (() => new.target)();",
      "nested.mjs": "function f() { return new.target === undefined; } class C { x = new.target; } export const value = [f(), new C().x];",
    },
    expected: "./direct.mjs SyntaxError\n./arrow.mjs SyntaxError\n./nested.mjs [ true, undefined ]\n",
  },
  "new.target raw eval": {
    files: {},
    entry: ["-e", "console.log(new.target);"],
    expected: "",
    status: 1,
  },
  // R5: a dependency's syntax errors stay SyntaxErrors and run nothing.
  "syntax error class": {
    files: {
      "main.mjs": "for (const file of ['./bad.mjs', './arguments.mjs', './link.mjs']) { try { await import(file); } catch (error) { console.log(file, error.name); } }",
      "bad.mjs": "console.log('bad ran'); export const = ;",
      "arguments.mjs": "console.log('arguments ran'); arguments = 1;",
      "link.mjs": "import './side.mjs'; import { missing } from './dep.mjs'; console.log('link ran', missing);",
      "side.mjs": "console.log('side ran');",
      "dep.mjs": "export const present = 1;",
    },
    expected: "./bad.mjs SyntaxError\n./arguments.mjs SyntaxError\n./link.mjs SyntaxError\n",
  },
  "arguments assignment raw eval": {
    files: {},
    entry: ["-e", "arguments = 1;"],
    expected: "",
    status: 1,
  },
  // R5 follow-up (reconciliation/CONST-WRITE.json): writing a constant or an imported binding
  // is valid module syntax that throws a TypeError when it runs, never when it loads.
  "const write": {
    files: {
      "main.mjs": "console.log('boot'); try { const m = await import('./dep.mjs'); console.log('loaded',m.value); try { m.change(); } catch(e) { console.log('call-error',e.constructor.name); } } catch(e) { console.log('import-error',e.constructor.name); }",
      "dep.mjs": "export const value = 1; export function change() { value = 2; }",
    },
    expected: "boot\nloaded 1\ncall-error TypeError\n",
  },
  "const write raw eval": {
    files: {},
    entry: ["-e", "const a = 1; try { (() => { a = 2; })(); } catch (error) { console.log(error.constructor.name); } console.log(a);"],
    expected: "TypeError\n1\n",
  },
  "import binding writes": {
    files: {
      "main.mjs": "const m = await import('./importer.mjs'); for (const name of ['writeImport', 'updateImport', 'writeNamespace', 'neverCalled']) { try { m[name](); console.log(name, 'ok'); } catch (error) { console.log(name, error.constructor.name); } }",
      "importer.mjs": "import { value } from './dep.mjs'; import * as ns from './dep.mjs'; export function writeImport() { value = 5; } export function updateImport() { value++; } export function writeNamespace() { ns = 6; } export function neverCalled() { if (false) value = 7; }",
      "dep.mjs": "export const value = 1;",
    },
    expected: "writeImport TypeError\nupdateImport TypeError\nwriteNamespace TypeError\nneverCalled ok\n",
  },
  // R6: `arguments` spelled with escapes, in a file and in raw eval input.
  "escaped arguments": {
    files: { "main.mjs": "globalThis.arguments = 42; console.log(arg\\u0075ments, typeof arg\\u{75}ments, \"é😀\".length);" },
    expected: "42 number 3\n",
  },
  "escaped arguments raw eval": {
    files: {},
    entry: ["-e", "globalThis.arguments = 42; console.log(arg\\u0075ments, typeof arg\\u0075ments);"],
    expected: "42 number\n",
  },
  // R7: a replaced global eval reaches neither CommonJS compilation nor the loader.
  "replaced eval": {
    files: {
      "main.mjs": "globalThis.eval = () => { throw new Error('replaced eval reached'); }; const lib = await import('./lib.cjs'); console.log('loaded', lib.default.x);",
      "lib.cjs": "exports.x = 1;",
    },
    expected: "loaded 1\n",
  },
  // CommonJS order: required before and after its import, it is one module; its exports
  // are read when the importer evaluates.
  "commonjs require order": {
    files: {
      "main.mjs": "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\nconst a = require('./a.cjs'); a.count = 2; const nsA = await import('./a.cjs');\nconst nsB = await import('./b.cjs'); const b = require('./b.cjs');\nconsole.log(nsA.default === a, nsA.count, nsB.default === b, globalThis.runs);",
      "a.cjs": "globalThis.runs = (globalThis.runs ?? 0) + 1; exports.count = 1;",
      "b.cjs": "globalThis.runs = (globalThis.runs ?? 0) + 1; exports.count = 1;",
    },
    expected: "true 2 true 2\n",
  },
  // CommonJS failure: the import rejects with the thrown error, and a retry runs it again.
  "commonjs failure and retry": {
    files: {
      "main.mjs": "for (let attempt = 0; attempt < 2; attempt++) { try { const lib = await import('./lib.cjs'); console.log('loaded', lib.default.attempt); } catch (error) { console.log('failed', error.message); } }",
      "lib.cjs": "globalThis.attempts = (globalThis.attempts ?? 0) + 1; if (globalThis.attempts === 1) throw new Error('first'); exports.attempt = globalThis.attempts;",
    },
    expected: "failed first\nloaded 2\n",
  },
};

function runCase(directory: string, wasm: string, modules: "store" | "records", entry: string[]) {
  return spawnSync("node", ["--no-warnings", resolve(root, "web/scripts/node-host.mjs"), "--wasm", wasm, "--modules", modules,
    "--context", "hooks", "--dir", `${directory}::/`, "--env", "PWD=/", "--env", "HOME=/", "--"].concat(entry),
  { cwd: root, encoding: "utf8", timeout: 30000 });
}

export function testModuleRecordControls(wasm: string): void {
  test("required ES modules retain their own metadata without capturing source names", () => {
    const fixture = join(root, "tests/fixtures/require-esm-meta");
    const expected = readFileSync(join(fixture, "expected.txt"), "utf8");
    for (const modules of ["store", "records"] as const) {
      const child = runCase(fixture, wasm, modules, ["run", "/index.cts"]);
      expect(child.error).toBeUndefined();
      expect(child.stderr).toBe("");
      expect(child.status).toBe(0);
      expect(child.stdout).toBe(expected);
    }
  }, 60000);

  test("module records match the module store on the source review's controls", () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-record-controls-"));
    try {
      const outcome = (stdout: string, status: number | null, stderr: string) =>
        ({ stdout, status, syntaxError: /SyntaxError/.test(stderr) });
      const actual = [];
      const expected = [];
      for (const [name, control] of Object.entries(cases)) {
        const directory = join(scratch, name.replaceAll(" ", "-"));
        mkdirSync(directory);
        for (const [file, text] of Object.entries(control.files)) {
          mkdirSync(dirname(join(directory, file)), { recursive: true });
          writeFileSync(join(directory, file), `${text}\n`);
        }
        const entry = control.entry ?? ["run", "/main.mjs"];
        const [store, records] = [runCase(directory, wasm, "store", entry), runCase(directory, wasm, "records", entry)];
        const status = control.status ?? 0;
        const wanted = outcome(control.expected, status, status === 0 ? "" : "SyntaxError");
        actual.push({ name, store: outcome(store.stdout, store.status, store.stderr), records: outcome(records.stdout, records.status, records.stderr) });
        expected.push({ name, store: wanted, records: wanted });
      }
      expect(actual).toEqual(expected);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 300000);

  // D2: function source may differ in formatting and literal spelling, never in structure.
  test("module records keep equality operands where they were written", () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-record-shape-"));
    try {
      writeFileSync(join(scratch, "main.mjs"), "const f = (x) => [1 != void 0, void 0 != 1, 1 === x, x === 1, null == x];\nconsole.log(f.toString());\n");
      const records = runCase(scratch, wasm, "records", ["run", "/main.mjs"]);
      expect(records.stdout).toBe("(x) => [1 != void 0, void 0 != 1, 1 === x, x === 1, null == x]\n");
      expect(records.status).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60000);
}
